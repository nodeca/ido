/* global describe, it, beforeEach, afterEach */
'use strict';


const assert = require('assert');
const bb     = require('bluebird');

const Queue  = require('../index');
const random = require('../lib/utils').random;


const REDIS_URL = 'redis://localhost:6379/3';


function delay(ms) { return bb.delay(ms); }


const clear_namespace = bb.coroutine(function* (ns) {
  const r = require('redis').createClient(REDIS_URL);
  const keys = yield r.keysAsync(`${ns}*`);

  if (keys.length) yield r.delAsync(keys);
});


describe('queue', function () {
  let q, q2, q_ns;

  beforeEach(bb.coroutine(function* () {
    q_ns = `idoit_test_${random(6)}:`;

    q  = new Queue({ redisURL: REDIS_URL, ns: q_ns });
    q2 = new Queue({ redisURL: REDIS_URL, ns: q_ns, pool: 'testPoolName' });

    // Helper to wait task finish
    q.wait = q2.wait = bb.coroutine(function* (id) {
      let task = yield this.getTask(id);

      while (task.state !== 'finished') {
        yield delay(50);
        task = yield this.getTask(id);
      }

      return task;
    });

    q.on('error', err => { throw err; });
    q2.on('error', err => { throw err; });

    yield q.start();
    yield q2.start();
  }));

  afterEach(bb.coroutine(function* () {
    q.shutdown();
    q2.shutdown();
    yield clear_namespace(q_ns);
  }));


  it('should set namespace', function () {
    q.options({ ns: 'foo' });

    assert.equal(q.__prefix__, 'foo');
    assert.equal(q.ns, 'foo');
  });


  it('should run chained groups', bb.coroutine(function* () {
    let calls = 0;

    q.registerTask('t1', function () {
      calls++;
    });

    let id = yield q.chain([
      q.group([
        q.t1(),
        q.t1()
      ]),
      q.group([
        q.t1(),
        q.t1()
      ])
    ]).run();

    yield q.wait(id);

    assert.equal(calls, 4);
  }));


  it('should cancel task with big nesting', bb.coroutine(function* () {
    q.registerTask({
      name: 't1',
      process() {}
    });

    let task = q.t1();

    for (let i = 0; i < 1000; i++) {
      task = q.chain([ task ]);
    }

    let id = yield task.run();

    yield q.cancel(id);
  }));


  it('should fail to cancel child task', bb.coroutine(function* () {
    q.registerTask({
      name: 't1',
      process() { return delay(2000); }
    });

    let child_task = q.t1();

    yield child_task;

    yield q.group([
      child_task,
      q.t1(),
      q.t1()
    ]).run();

    try {
      yield q.cancel(child_task.id);
    } catch (err) {
      if (/task with parent can not be cancelled/.test(err.message)) return;
    }

    throw new Error('q.cancel should fail');
  }));


  it('should update total from init', bb.coroutine(function* () {
    q.registerTask({
      name: 't1',
      process() {},
      init() {
        this.total = 10;
      }
    });

    q.registerTask({
      name: 't2',
      process() {},
      init() {
        return delay(10).then(() => { this.total = 7; });
      }
    });

    let id = yield q.group([
      q.t1(),
      q.t2()
    ]).run();

    let task = yield q.getTask(id);

    assert.equal(task.total, 17);
  }));


  it('should set progress tree root', bb.coroutine(function* () {
    q.registerTask({
      name: 't1',
      process() {},
      init() {
        this.total = 11;
      }
    });

    q.registerTask({
      name: 't2',
      process() {},
      init() {
        this.total = 7;
      }
    });


    let id = yield q.group([
      q.chain([
        q.t1(),
        q.t1()
      ]),
      q.chain([
        q.t2(),
        q.t2()
      ])
    ]).run();

    let task = yield q.wait(id);

    assert.equal(task.total, 36);
    assert.equal(task.progress, 36);
  }));


  it('should run task in specified pool', bb.coroutine(function* () {
    let calls = 0;

    [
      {
        name: 't1',
        process() {
          calls++;
          assert.equal(this.pool, 'default');
          assert.equal(q.pool, this.pool);
        },
        pool: 'default'
      },
      {
        name: 't2',
        process() {
          calls++;
          assert.equal(this.pool, 'testPoolName');
          assert.equal(q2.pool, this.pool);
        },
        pool: 'testPoolName'
      }
    ].forEach(t => {
      q.registerTask(t);
      q2.registerTask(t);
    });

    let id1 = yield q.t1().run();
    let id2 = yield q.t2().run();

    yield q.wait(id1);
    yield q.wait(id2);

    assert.equal(calls, 2);
  }));


  it('should consume tasks from multiple puuls if set', bb.coroutine(function* () {
    q.registerTask({ name: 't1', process() {} });
    q.registerTask({ name: 't2', process() {} });

    q.options({ pool: [ 'default', 'secondary' ] });

    let id = yield q.group([
      q.t1(),
      q.t2().options({ pool: 'secondary' })
    ]).run();

    let task = yield q.wait(id);

    assert.equal(task.state, 'finished');
  }));


  it('cron should run task once per second', function (done) {
    let t1Calls = 0;
    let startTime = Date.now();
    let maxDrift = 100;

    q.registerTask('t1', '* * * * * *', () => {
      t1Calls++;

      if (t1Calls <= 5) {
        let actual = Date.now() - startTime;
        let planned = t1Calls * 1000;

        assert.ok(planned - maxDrift <= actual && actual <= planned + maxDrift);
      }

      if (t1Calls === 5) {
        done();
      }
    });
  });


  it('cancel should throw if parent exists', bb.coroutine(function* () {
    q.registerTask('t1', () => {});

    let children = [
      q.t1()
    ];

    yield q.group(children).run();

    try {
      yield q.cancel(children[0].id);
    } catch (err) {
      assert.ok(err.message.indexOf('idoit error: task with parent can not be cancelled') !== -1);
      return;
    }

    throw new Error('Failed to throw on invalid cancel');
  }));


  it('should throw on missed `redisURL`', function () {
    assert.throws(() => {
      /* eslint-disable no-new */
      new Queue();
    }, /idoit error: "redisURL" is required/);
  });


  it('should throw on register the same task twice', function () {
    assert.throws(() => {
      q.registerTask({ name: 't', process() {} });
      q.registerTask({ name: 't', process() {} });
    }, /Queue registerTask error/);
  });


  it('should wait active tasks on shutdown', bb.coroutine(function* () {
    q.registerTask({
      name: 't',
      process() {
        return delay(2000);
      }
    });

    q.t().run();

    while (q.__tasksTracker__ === 0) {
      yield delay(50);
    }

    let begin_ts = Date.now();

    yield q.shutdown();

    let elapsed = Date.now() - begin_ts;

    if (elapsed < 1500) {
      throw new Error('Failed to wait for active task on shutdown');
    }
  }));


  it('should limit concurrency', bb.coroutine(function* () {
    let activeCnt = 0;

    q.registerTask({
      name: 't',
      process() {
        return Promise.resolve()
          .then(() => {
            activeCnt++;
            assert.equal(activeCnt, 1, 'Failed to limit concurrency');
          })
          .then(() => delay(1000))
          .then(() => {
            activeCnt--;
          });
      }
    });

    q.options({ concurrency: 1 });

    let id = yield q.group([ q.t(), q.t(), q.t(), q.t() ]).run();

    yield q.wait(id);
  }));


  it('`.cancel()` should not fail with bad task id', bb.coroutine(function* () {
    yield q.cancel('bad_id');
  }));


  it('`.getTask()` should return `null` on wrong queue instance', bb.coroutine(function* () {
    q.registerTask('t', () => {});

    let id = yield q.t().run();
    let task = yield q2.getTask(id);

    assert.strictEqual(task, null);
  }));


  it('`.cancel()` should ignore finished tasks', bb.coroutine(function* () {
    q.registerTask('t', () => delay(100));

    let children = [ q.t(), q.t() ];
    let chainID = yield q.chain(children).run();

    yield q.wait(children[0].id);
    yield q.cancel(chainID);

    let chain = yield q.getTask(chainID);
    let first = yield q.getTask(children[0].id);
    let second = yield q.getTask(children[1].id);

    assert.equal(chain.state, 'finished');
    assert.equal(chain.error.code, 'CANCELED');

    assert.equal(first.state, 'finished');
    assert.equal(typeof first.error, 'undefined');

    assert.equal(second.state, 'finished');
    assert.equal(second.error.code, 'CANCELED');
  }));


  it('should re-emit redis errors', bb.coroutine(function* () {
    q.removeAllListeners('error');

    let p = new Promise(resolve => {
      q.once('error', err => {
        assert.equal(err, 'redis error');
        resolve();
      });
    });

    q.__redis__.emit('error', 'redis error');

    yield p;
  }));


  it('should emit "task:end" event', function (done) {
    q.registerTask('t', () => {});

    let t = q.t();

    q.on('task:end', data => {
      assert.equal(data.id, t.id);
      assert.equal(data.uid, t.uid);
      done();
    });

    t.run();
  });


  it('should emit "task:end:<task_id>" event', function (done) {
    q2.shutdown();

    q.registerTask('t', () => {});

    let calls = 0;
    let t = q.t();

    q.registerTask({ name: 'i',  baseClass: Queue.IteratorTemplate, iterate(i = 0) {
      if (i === 0) return Promise.resolve({ state: 1, tasks: [ t ] });
      return Promise.resolve(null);
    } });

    let i = q.i();
    let g = q.group([ i ]);
    let c = q.chain([ g ]);

    bb.all([ t, i, g, c ]).then(() => {
      q.on(`task:end:${t.id}`, data => {
        calls++;
        assert.equal(data.id, t.id);
        assert.equal(data.uid, t.uid);
      });

      q.on(`task:end:${i.id}`, data => {
        calls++;
        assert.equal(data.id, i.id);
        assert.equal(data.uid, i.uid);
      });

      q.on(`task:end:${g.id}`, data => {
        calls++;
        assert.equal(data.id, g.id);
        assert.equal(data.uid, g.uid);
      });

      q.on(`task:end:${c.id}`, data => {
        calls++;
        assert.equal(calls, 4);
        assert.equal(data.id, c.id);
        assert.equal(data.uid, c.uid);
        done();
      });

      c.run();
    });
  });


  it('`.cancel()` should emit "task:end" event', bb.coroutine(function* () {
    q.registerTask('t1', () => delay(10000000));
    q.registerTask('t2', () => {});

    let t1 = q.t1();
    let t2 = q.t2();
    let t1id = yield t1.run();
    let t2id = yield t2.run();

    let t1EndCalls = 0;
    let t2EndCalls = 0;

    q.on(`task:end:${t1id}`, data => {
      t1EndCalls++;
      assert.equal(data.id, t1id);
      assert.equal(data.uid, t1.uid);
    });

    q.on(`task:end:${t2id}`, data => {
      t2EndCalls++;
      assert.equal(data.id, t2id);
      assert.equal(data.uid, t2.uid);
    });

    yield q.wait(t2id);

    assert.equal(t1EndCalls, 0);
    assert.equal(t2EndCalls, 1);

    yield q.cancel(t1id);
    yield q.cancel(t2id);

    assert.equal(t1EndCalls, 1);
    assert.equal(t2EndCalls, 1);
  }));


  it('should emit "task:progress:<task_id>" event', function (done) {
    q2.shutdown();

    q.registerTask('t', () => {});

    let c = q.chain([ q.t(), q.t(), q.t(), q.t() ]);

    c.run().then(id => {
      let calls = 0;

      q.on(`task:progress:${id}`, data => {
        calls++;
        assert.equal(data.progress, calls);
        assert.equal(data.total, 4);
        assert.equal(data.id, id);
        assert.equal(data.uid, c.uid);

        if (calls === 4) done();
      });
    });
  });


  describe('transaction', function () {
    // TODO: tests for validate are missing

    it('should execute redis commands', bb.coroutine(function* () {
      let a = 'key:' + random(6), b = 'value:' + random(6);

      yield q.__redis__.evalAsync(
        q.__scripts__.transaction,
        1,
        JSON.stringify({
          validate: [],
          exec: [
            [ 'set', a, b ]
          ]
        })
      );

      assert.equal(yield q.__redis__.getAsync(a), b);
    }));


    it('should evaluate scripts by sha', bb.coroutine(function* () {
      let a = 'key:' + random(6), b = 'value:' + random(6);

      let script = "redis.call('set', KEYS[1], ARGV[1])";
      let sha = yield q.__redis__.scriptAsync('load', script);

      yield q.__redis__.evalAsync(
        q.__scripts__.transaction,
        1,
        JSON.stringify({
          validate: [],
          exec: [
            [ 'evalsha', sha, 1, a, b ]
          ]
        })
      );

      assert.equal(yield q.__redis__.getAsync(a), b);
    }));


    it('should evaluate scripts by text', bb.coroutine(function* () {
      let a = 'key:' + random(6), b = 'value:' + random(6);

      let script = "redis.call('set', KEYS[1], ARGV[1])";

      yield q.__redis__.evalAsync(
        q.__scripts__.transaction,
        1,
        JSON.stringify({
          validate: [],
          exec: [
            [ 'eval', script, 1, a, b ]
          ]
        })
      );

      assert.equal(yield q.__redis__.getAsync(a), b);
    }));
  });
});
