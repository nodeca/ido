'use strict';


const EventEmitter     = require('events').EventEmitter;
const CronJob          = require('cron').CronJob;
const serializeError   = require('serialize-error').serializeError;
const utils            = require('./utils');
const Redis            = require('ioredis');
const redisIf          = require('redis-if');


const QueueError       = require('./error');
const TaskTemplate     = require('./task_template');
const ChainTemplate    = require('./chain_template');
const GroupTemplate    = require('./group_template');
const IteratorTemplate = require('./iterator_template');
const Command          = require('./command');


///////////////////////////////////////////////////////////////////////////////


class Queue extends EventEmitter {
  constructor({ redisURL, concurrency = 100, pool = 'default', ns = 'idoqueue:' } = {}) {
    super();

    if (!redisURL) {
      throw new Error('idoit error: "redisURL" is required');
    }

    // Add empty handler to avoid unhandled exceptions
    // (suppress default EventEmitter behaviour)
    this.on('error', () => {});

    this.__redis_url__ = redisURL;
    this.options({ concurrency, pool, ns });

    this.__redis__        = null;
    this.__timer__        = null;
    this.__stopped__      = true;
    this.__types__        = {};
    this.__tasksTracker__ = 0;
    this.__ready__        = null;
    this.__crons__        = []; // needed to clean up cron jobs in tests

    // list of functions to generate
    this.gcFunctions = [
      (queue, id) => `${queue.__prefix__}${id}`,
      (queue, id) => `${queue.__prefix__}ichunks:${id}` // for iterator
    ];

    // Register default operators
    this.registerTask({ name: 'chain', baseClass: ChainTemplate });
    this.registerTask({ name: 'group', baseClass: GroupTemplate });

    this.__init__();
  }


  // Return promise, resolved when queue is ready to accept commands
  // (after 'ready' emited)
  //
  ready() {
    return this.__ready__;
  }


  // Start queue processing. Should be called after all tasks registered.
  //
  start() {
    this.__stopped__ = false;
    return this.ready();
  }


  // Proxy to simplify options set
  get ns() { return this.__prefix__; }
  set ns(val) { this.__prefix__ = val; }


  // Update queue options
  //
  options(opts) {
    Object.assign(this, opts);
    return this;
  }


  // Stop accepting new tasks from queue & wait until active tasks done.
  //
  async shutdown() {
    this.__stopped__ = true;

    while (this.__tasksTracker__ !== 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    return true;
  }


  // Register task
  //
  // registerTask(name [, cron], process):
  //
  // - name (String) - the task's name
  // - cron (String) - optional, cron string ("15 */6 * * *"), default null
  // - process (Function) - called as: `task.process()`
  //   - this (Object) - current task (task data is available as `this.args`)
  //
  // registerTask(options):
  //
  // - options (Object)
  //   - name (String) - the task's name
  //   - baseClass (Function) - optional, base task's constructor, default Task
  //   - init (Function) - optional, initialize function to change the task's payload
  //   - taskID (Function)
  //   - process (Function) - called as: `task.process(...args)`
  //     - this (Object) - current task (task data is available as `this.args`)
  //   - pool (String) - optional, pool name, default `default`
  //   - retry (Number) - optional, number of retry on error, default 2.
  //   - retryDelay (Number) - optional, delay in ms after retries, default 60000 ms.
  //   - timeout (Number) - optional, execution timeout, default 120000 ms.
  //   - postponeDelay (Number) - optional, if postpone is called without delay,
  //     delay is assumed to be equal to this value (in milliseconds).
  //   - cron (String) - optional, cron string ("15 */6 * * *"), default null
  //   - track (Number) - default 3600000ms (1hr). Time to remember scheduled
  //     tasks from cron to avoid rerun if several servers in cluster have wrong
  //     clocks. Don't set too high for very frequent tasks, because it can occupy
  //     a lot of memory.
  //
  registerTask(...args) {
    let options;

    if (args.length === 1) {
      // invoked as `registerTask(options)`
      options = Object.assign({}, args[0]);
      options.baseClass = options.baseClass || TaskTemplate;

    } else if (args.length === 2) {
      // invoked as `registerTask(name, process)`
      options = {
        baseClass: TaskTemplate,
        name:      args[0],
        process:   args[1]
      };

    } else {
      // invoked as `registerTask(name, cron, process)`
      options = {
        baseClass: TaskTemplate,
        name:      args[0],
        cron:      args[1],
        process:   args[2]
      };
    }

    if (this.__types__[options.name]) {
      throw new Error(`Queue registerTask error: task with name "${options.name}" already registered.`);
    }

    // `baseClass` & `cron` are processed in this method, everything else
    // goes to task prototype.
    let task_defaults = {};

    Object.keys(options).forEach(k => {
      if (k !== 'baseClass' && k !== 'cron') task_defaults[k] = options[k];
    });

    let TaskClass = options.baseClass.extend(task_defaults);

    this.__types__[options.name] = TaskClass;

    //
    // Create fabric to build tasks of this type as
    // `queue.<task_name>(params)`
    //
    this[options.name] = (...args) => {
      let task = new TaskClass(this, ...args);

      task.then = (onFulfilled, onRejected) => {
        if (!task.__prepare_promise__) {
          task.__prepare_promise__ = task.prepare();
        }

        return task.__prepare_promise__.then(onFulfilled, onRejected);
      };

      return task;
    };


    if (options.cron) {
      let track = options.hasOwnProperty('track') ? options.track : 1 * 60 * 60 * 1000;

      this.__schedule__(options.name, options.cron, track);
    }
  }


  // Fetch task data without casting to class.
  //
  async __getRawTask__(id) {

    let serializedPayload = await this.__redis__.hgetall(`${this.__prefix__}${id}`);

    if (Object.keys(serializedPayload).length === 0) return null;

    // unserialize each field
    return Object.keys(serializedPayload).reduce((acc, key) => {
      acc[key] = JSON.parse(serializedPayload[key]);
      return acc;
    }, {});
  }


  // Fetch multiple task data without casting to class.
  //
  async __getRawTasks__(ids) {
    let query = this.__redis__.multi();

    ids.forEach(id => query.hgetall(`${this.__prefix__}${id}`));

    let serializedPayloads = await query.exec();

    return serializedPayloads.map(p => {
      let keys = Object.keys(p[1]);

      // not exists -> null
      if (keys.length === 0) return null;

      // unserialize each field
      return keys.reduce((acc, key) => {
        acc[key] = JSON.parse(p[1][key]);
        return acc;
      }, {});
    });
  }


  // Get task by global task id
  //
  async getTask(id) {
    // Unserialize payload
    let payload = await this.__getRawTask__(id);

    if (!payload) return null;

    let TaskClass = this.__types__[payload.name];

    if (!TaskClass) return null;

    let task = new TaskClass(this);

    // Restore task from payload
    task.fromObject(payload);

    return task;
  }


  // Cancel task by id (you can cancel only tasks without parent)
  //
  async cancel(id) {
    let task = await this.getTask(id);

    if (!task) return;

    if (task.parent) {
      throw new Error(`idoit error: task with parent can not be cancelled, task id ${id}`);
    }

    // Collect all children of this task
    let tasks = await task.__fillCancelInfo__();
    let cancelIDs = tasks.map(t => t.id);

    let pools = new Set();

    for (let t of tasks) pools.add(t.pool);

    let prefix = this.__prefix__;

    // Remove tasks from all states collections, except `finished`
    //
    let query = this.__redis__.multi()
      .srem(`${prefix}waiting`, cancelIDs)
      .srem(`${prefix}idle`, cancelIDs)
      .zrem(`${prefix}locked`, cancelIDs)
      .zrem(`${prefix}restart`, cancelIDs);

    for (let pool of pools) {
      query.srem(`${prefix}${pool}:startable`, cancelIDs);
    }

    // Calculate number of commands before transactions, to get results later
    let shift = 4 + pools.size;

    // Add transaction to:
    //
    // - move tasks to `finished`
    // - update their state
    // - save error
    //
    let time  = utils.redisToMs(await this.__redis__.time());
    let state = JSON.stringify('finished');
    let error = JSON.stringify({ code: 'CANCELED', name: 'Error', message: 'idoit error: task canceled' });

    // filter out tasks that are already deleted or cancelled
    let _tasks = tasks;
    cancelIDs = cancelIDs.filter((__, i) => _tasks[i] && _tasks[i].state !== 'finished');
    tasks     = tasks.filter((__, i) => _tasks[i] && _tasks[i].state !== 'finished');

    cancelIDs.forEach((id, i) => {
      let removeDeadline = time + tasks[i].removeDelay;

      query.transaction(
        JSON.stringify({
          if: [
            [ state, '!=', [ 'hget', `${prefix}${id}`, 'state' ] ]
          ],
          exec: [
            [ 'zadd', `${prefix}finished`, removeDeadline, id ],
            [ 'hset', `${prefix}${id}`, 'state', state ],
            [ 'hset', `${prefix}${id}`, 'error', error ]
          ]
        })
      );
    });


    let res = await query.exec();

    // Fetch uids (for `task:end` event)
    //
    let uidsQuery = this.__redis__.multi();

    cancelIDs.forEach(id => {
      uidsQuery.hget(`${prefix}${id}`, 'uid');
    });

    let uids = await uidsQuery.exec();

    cancelIDs.forEach((id, i) => {
      if (!res[i + shift][1]) return;

      let eventData = { id, uid: JSON.parse(uids[i][1]) };

      this.emit('task:end', eventData);
      this.emit(`task:end:${id}`, eventData);
    });
  }


  // Force restart of a running task
  //
  async __restartTask__(task, add_retry, delay) {
    // If retry count is exceeded, task will finish naturally
    // and won't be restarted
    if (add_retry && task.retries >= task.retry - 1) return;

    let time = utils.redisToMs(await this.__redis__.time());
    let prefix = this.__prefix__;

    let new_retries = task.retries + (add_retry ? 1 : 0);

    let success = await this.__redis__.transaction(
      JSON.stringify({
        if: [
          // remove task from locked set and ensure it was there
          [ 1, [ 'zrem', `${prefix}locked`, task.id ] ]
        ],
        exec: [
          [ 'zadd', `${prefix}restart`, delay + time, task.id ],
          [ 'hset', `${prefix}${task.id}`, 'state', JSON.stringify('restart') ],
          [ 'hset', `${prefix}${task.id}`, 'retries', JSON.stringify(new_retries) ]
        ]
      })
    );

    if (!success) {
      throw new Error(`idoit error: unable to restart task ${task.id}`);
    }
  }


  // Add new task to waiting
  //
  // - task
  // - delay (Number) - optional, postpone task execution
  //
  async __addTask__(task, delay) {
    let query        = this.__redis__.multi();
    let prefix       = this.__prefix__;

    let previousTask = await this.__getRawTask__(task.id);

    if (previousTask) {
      // If active task with the same id already exists - return it.
      if (previousTask.state !== 'finished') return previousTask.id;

      // If finished task with the same id exists - remove it
      query
        .zrem(`${prefix}finished`, previousTask.id)
        .del(`${prefix}${previousTask.id}`);
    }

    let taskQueue = [ task ];

    // Iterate through each child in tree
    while (taskQueue.length > 0) {
      let t       = taskQueue.shift();
      let payload = t.toObject();

      let serializedPayload = Object.keys(payload).reduce((acc, key) => {
        acc[key] = JSON.stringify(payload[key]);
        return acc;
      }, {});

      // Save task data
      query.hmset(`${prefix}${t.id}`, serializedPayload);
      // Add task id to `waiting` set
      query.sadd(`${prefix}waiting`, t.id);

      taskQueue = taskQueue.concat(t.__children_to_init__ || []);
    }

    let time = utils.redisToMs(await this.__redis__.time());

    // Create task `activate` command
    query.zadd(`${prefix}${task.pool}:commands`, time + (delay || 0), Command.fromObject({
      type:   'activate',
      to:     task.id,
      to_uid: task.uid
    }).toJSON());

    await query.exec();

    setImmediate(async () => {
      try {
        await this.__consumeCommands__();
        await this.__consumeTasks__();
      } catch (err) {
        this.emit('error', err);
      }
    });

    return task.id;
  }


  // Check if task was registered on this instance
  //
  __hasKnownTask__(id) {
    return this.__redis__.hget(`${this.__prefix__}${id}`, 'name').then(name => {
      name = JSON.parse(name);

      return !!this.__types__[name];
    });
  }


  // Schedule the task executions
  //
  // - worker (Object) - worker options
  //
  __schedule__(taskName, cronString, trackTime) {
    let job = new CronJob(cronString, (async function () {
      try {

        if (this.__stopped__) return;

        if (!trackTime) {
          await this[taskName]().run();
          return;
        }

        // To generate `sheduledID` we use timestamp of next exec because `node-cron`
        // doesn't present timestamp of current exec
        //
        let scheduledID = `${this.__prefix__}cron:${taskName}:${job.cronTime.sendAt().format('X')}`;


        // Check if another instance scheduled the task
        let acquired = await this.__redis__.setnx(scheduledID, scheduledID);

        // Exit if the task already scheduled in different instance
        if (!acquired) return;

        // Set tracker lifetime (3 days) to auto collect garbage
        await this.__redis__.expire(scheduledID, trackTime / 1000);

        await this[taskName]().run();

      } catch (err) {
        this.emit('error', err);
      }
    }).bind(this));

    this.__crons__.push(job);

    job.start();
  }


  // Execute task
  //
  // - move from `startable` to `locked`
  // - execute task
  // - move from `locked` to `finished`
  //
  async __execTask__(id) {
    let time = utils.redisToMs(await this.__redis__.time());
    let task = await this.getTask(id);
    let prefix = this.__prefix__;

    // If task deleted - skip
    if (!task) return;


    // If parent task already finished - cancel this task
    //
    if (task.parent) {
      let parent = await this.__getRawTask__(task.parent);

      if (!parent || parent.state === 'finished') {
        let error = JSON.stringify({ code: 'CANCELED', name: 'Error', message: 'idoit error: task canceled' });

        let transaction = {
          if: [
            [ JSON.stringify('startable'), [ 'hget', `${prefix}${task.id}`, 'state' ] ]
          ],
          exec: [
            [ 'srem', `${prefix}${task.pool}:startable`, task.id ],
            [ 'zadd', `${prefix}finished`, time + task.removeDelay, task.id ],
            [ 'hset', `${prefix}${task.id}`, 'state', JSON.stringify('finished') ],
            [ 'hset', `${prefix}${task.id}`, 'error', error ]
          ]
        };

        let success = await this.__redis__.transaction(JSON.stringify(transaction));

        if (success) {
          let eventData = { id: task.id, uid: task.uid };

          this.emit('task:end', eventData);
          this.emit(`task:end:${task.id}`, eventData);
        }

        return;
      }
    }


    task.__deadline__ = task.timeout + time;

    let prefix_pool = prefix + task.pool + ':';

    // Try to acquire task lock (move to `locked` set)
    let locked = await this.__redis__.transaction(
      JSON.stringify({
        if: [
          [ JSON.stringify('startable'), [ 'hget', `${prefix}${task.id}`, 'state' ] ]
        ],
        exec: [
          [ 'srem', `${prefix_pool}startable`, task.id ],
          [ 'zadd', `${prefix}locked`, task.__deadline__, task.id ],
          [ 'hset', `${prefix}${task.id}`, 'state', JSON.stringify('locked') ]
        ]
      })
    );

    if (!locked) return;

    // If task should be terminated, 2 things must be done:
    //
    // - update state (done via watchdog in `.__tick__()`)
    // - release "busy" counters in local process (see below)
    //
    // It doesn't matter, which action will be executed first.
    //
    let terminated = false;
    let terminateTimerId = setTimeout(() => {
      // Do nothing if deadline changed inside task
      // TODO: create new terminate timer
      if (task.__deadline__ !== task.timeout + time) return;

      this.__tasksTracker__--;
      terminated = true;
    }, task.timeout);

    this.__tasksTracker__++;

    let result, error;

    try {
      result = await task.process(...task.args);
    } catch (err) {
      error = err;
    }

    clearTimeout(terminateTimerId);

    // If task timed out before `.process()` end - do nothing,
    // cleanup will be done by watchdog
    if (terminated) return;

    this.__tasksTracker__--;

    time = utils.redisToMs(await this.__redis__.time());


    // If error we should postpone next retry of task run
    //
    if (error) {
      if (task.retries >= task.retry - 1) {
        // If retries count exceeded - finish task
        let transaction = {
          if: [
            [ String(task.__deadline__), [ 'zscore', `${prefix}locked`, task.id ] ]
          ],
          exec: [
            [ 'zrem', `${prefix}locked`, task.id ],
            [ 'zadd', `${prefix}finished`, task.removeDelay + time, task.id ],
            [ 'hset', `${prefix}${task.id}`, 'error', JSON.stringify(serializeError(error)) ],
            [ 'hset', `${prefix}${task.id}`, 'state', JSON.stringify('finished') ]
          ]
        };

        if (task.parent) {
          // Send command with error to parent
          transaction.exec.push([ 'zadd', `${prefix}${task.parent_pool}:commands`, time, Command.fromObject({
            to:     task.parent,
            to_uid: task.parent_uid,
            type:   'error',
            data:   { error: serializeError(error) }
          }).toJSON() ]);
        }

        let success = await this.__redis__.transaction(JSON.stringify(transaction));

        if (success) {
          let parentFinished = task.parent && (await this.getTask(task.parent)).state === 'finished';

          // Suppress error messages from children of finished tasks,
          // it's needed in case cancel() doesn't stop all children tasks due to race condition
          // (i.e. iterator spawns new children while cancel() is collecting them)
          //
          /* eslint-disable max-depth */
          if (!parentFinished) {
            this.emit('error', new QueueError(error, task.name, 'locked', task.id, task.args));
          }

          let eventData = { id: task.id, uid: task.uid };

          this.emit('task:end', eventData);
          this.emit(`task:end:${task.id}`, eventData);
        }

      } else {
        // Schedule next restart
        let success = await this.__redis__.transaction(
          JSON.stringify({
            if: [
              [ String(task.__deadline__), [ 'zscore', `${prefix}locked`, task.id ] ]
            ],
            exec: [
              [ 'zrem', `${prefix}locked`, task.id ],
              [ 'zadd', `${prefix}restart`, task.retryDelay + time, task.id ],
              [ 'hset', `${prefix}${task.id}`, 'state', JSON.stringify('restart') ],
              [ 'hset', `${prefix}${task.id}`, 'retries', JSON.stringify(1 + task.retries) ]
            ]
          })
        );

        if (success) {
          let parentFinished = task.parent && (await this.getTask(task.parent)).state === 'finished';

          // Suppress error messages from children of finished tasks,
          // it's needed in case cancel() doesn't stop all children tasks due to race condition
          // (i.e. iterator spawns new children while cancel() is collecting them)
          //
          /* eslint-disable max-depth */
          if (!parentFinished) {
            this.emit('error', new QueueError(error, task.name, 'locked', task.id, task.args));
          }
        }
      }


    } else {
      // If success - move task to `finished`
      //
      let transaction = {
        if: [
          [ String(task.__deadline__), [ 'zscore', `${prefix}locked`, task.id ] ]
        ],
        exec: [
          [ 'zrem', `${prefix}locked`, task.id ],
          [ 'zadd', `${prefix}finished`, task.removeDelay + time, task.id ],
          [ 'hset', `${prefix}${task.id}`, 'state', JSON.stringify('finished') ],

          // Set progress
          [ 'hset', `${prefix}${task.id}`, 'progress', task.total ]
        ]
      };

      if (typeof result !== 'undefined') {
        transaction.exec.push([ 'hset', `${prefix}${task.id}`, 'result', JSON.stringify(result) ]);
      }

      if (task.parent) {
        // Send command with result to parent
        transaction.exec.push([ 'zadd', `${prefix}${task.parent_pool}:commands`, time, Command.fromObject({
          to:     task.parent,
          to_uid: task.parent_uid,
          type:   'result',
          data:   { id: task.id, result }
        }).toJSON() ]);

        // Get actual task progress
        let progress = JSON.parse(await this.__redis__.hget(`${prefix}${task.id}`, 'progress'));

        if (task.total !== progress) {
          // Send command with progress to parent
          transaction.exec.push([ 'zadd', `${prefix}${task.parent_pool}:commands`, time, Command.fromObject({
            to:     task.parent,
            to_uid: task.parent_uid,
            type:   'progress',
            data:   task.total - progress
          }).toJSON() ]);
        }
      }

      let success = await this.__redis__.transaction(JSON.stringify(transaction));

      if (success) {
        let eventData = { id: task.id, uid: task.uid };

        this.emit('task:end', eventData);
        this.emit(`task:end:${task.id}`, eventData);
      }
    }

    if (this.__stopped__) return;

    await this.__consumeCommands__();
    await this.__consumeTasks__();
  }


  // Run all startable tasks
  //
  async __consumeTasks__() {
    if (this.__tasksTracker__ >= this.concurrency) return;

    let pools = Array.isArray(this.pool) ? this.pool : [ this.pool ];

    for (let pool of pools) {
      let prefix_pool = `${this.__prefix__}${pool}:`;

      let IDs = await this.__redis__.srandmember(
        `${prefix_pool}startable`,
        this.concurrency - this.__tasksTracker__
      );

      for (let i = 0; i < IDs.length; i++) {
        // We can get tasks above allowed if multiple pools used
        if (this.__tasksTracker__ >= this.concurrency) return;

        let hasTask = await this.__hasKnownTask__(IDs[i]);

        if (!hasTask) continue;

        // Execute tasks in parallel
        this.__execTask__(IDs[i]).catch(err => this.emit('error', err));
      }
    }
  }


  // Run commands from transaction queue
  //
  async __consumeCommands__() {
    let pools = Array.isArray(this.pool) ? this.pool : [ this.pool ];

    for (let pool of pools) {
      let prefix_pool = `${this.__prefix__}${pool}:`;
      let time        = utils.redisToMs(await this.__redis__.time());

      let commands = await this.__redis__.zrangebyscore(
        `${prefix_pool}commands`,
        '-inf',
        time,
        'LIMIT',
        0,
        10,
        'withscores'
      );


      for (let i = 0; i < commands.length; i += 2) {
        let score = commands[i + 1];
        let cmd   = Command.fromJSON(commands[i]);

        let hasTask = await this.__hasKnownTask__(cmd.to);

        if (!hasTask) continue;

        let lockLifetime = utils.redisToMs(await this.__redis__.time()) + 30000;

        let locked = await this.__redis__.transaction(
          JSON.stringify({
            if: [
              [ String(score), [ 'zscore', `${prefix_pool}commands`, commands[i] ] ]
            ],
            exec: [
              [ 'zrem', `${prefix_pool}commands`, commands[i] ],
              [ 'zadd', `${prefix_pool}commands_locked`, lockLifetime, commands[i] ]
            ]
          })
        );

        if (!locked) continue;

        let task = await this.getTask(cmd.to);

        // If singletone task finishes, some commands can still be in queue.
        // So, if we rerun such task immediately, it should ignore old commands.
        if (task && task.uid === cmd.to_uid) {
          await task.handleCommand(cmd);
        }


        // Remove locked command. Usually task should remove command by itself, this needed when:
        //
        // - task already removed
        // - uid is invalid
        //
        await this.__redis__.zrem(`${prefix_pool}commands_locked`, commands[i]);
      }
    }
  }


  //
  //
  async __tick__() {
    if (this.__stopped__) return;

    let pools = Array.isArray(this.pool) ? this.pool : [ this.pool ];

    for (let pool of pools) {

      let query       = this.__redis__.multi();
      let prefix      = this.__prefix__;
      let prefix_pool = `${this.__prefix__}${pool}:`;
      let time        = utils.redisToMs(await this.__redis__.time());


      // (watchdog) Consume pending commands if those were not catched before
      //
      let suspendedCommands = await this.__redis__.zrangebyscore(
        `${prefix_pool}commands_locked`, '-inf', time, 'withscores');

      for (let i = 0; i < suspendedCommands.length; i += 2) {
        let command = suspendedCommands[i];
        let score = suspendedCommands[i + 1];

        query.transaction(
          JSON.stringify({
            if: [
              [ String(score), [ 'zscore', `${prefix_pool}commands_locked`, command ] ]
            ],
            exec: [
              [ 'zrem', `${prefix_pool}commands_locked`, command ],
              [ 'zadd', `${prefix_pool}commands`, time, command ]
            ]
          })
        );
      }


      // (watchdog) Restart suspended tasks (move `locked` -> `startable`)
      //
      // TODO: probably should restrict tasks to this pool only
      //
      let suspendedIDs = await this.__redis__.zrangebyscore(`${prefix}locked`, '-inf', time, 'withscores');

      for (let i = 0; i < suspendedIDs.length; i += 2) {
        let id     = suspendedIDs[i];
        let score  = suspendedIDs[i + 1];

        let pool = JSON.parse(await this.__redis__.hget(`${prefix}${id}`, 'pool'));

        query.transaction(
          JSON.stringify({
            if: [
              [ String(score), [ 'zscore', `${prefix}locked`, id ] ]
            ],
            exec: [
              [ 'zrem', `${prefix}locked`, id ],
              [ 'sadd', `${prefix}${pool}:startable`, id ],
              [ 'hset', `${prefix}${id}`, 'state', JSON.stringify('startable') ]
            ]
          })
        );
      }


      // Schedule postponed restarts (move `restart` -> `<pool>:startable`)
      //
      let restartIDs = await this.__redis__.zrangebyscore(`${prefix}restart`, '-inf', time, 'withscores');

      for (let i = 0; i < restartIDs.length; i += 2) {
        let id     = restartIDs[i];
        let score  = restartIDs[i + 1];

        let pool = JSON.parse(await this.__redis__.hget(`${prefix}${id}`, 'pool'));
        let prefix_pool = prefix + pool + ':';

        query.transaction(
          JSON.stringify({
            if: [
              [ String(score), [ 'zscore', `${prefix}restart`, id ] ]
            ],
            exec: [
              [ 'zrem', `${prefix}restart`, id ],
              [ 'sadd', `${prefix_pool}startable`, id ],
              [ 'hset', `${prefix}${id}`, 'state', JSON.stringify('startable') ]
            ]
          })
        );
      }


      // (gc) Remove old finished tasks
      //
      let oldFinishedIds = await this.__redis__.zrangebyscore(`${prefix}finished`, '-inf', time);

      for (let id of oldFinishedIds) {
        for (let fn of this.gcFunctions) {
          query.del(fn(this, id));
        }

        query.zrem(`${prefix}finished`, id);
      }


      await query.exec();
      await this.__consumeCommands__();
      await this.__consumeTasks__();
    }
  }


  // Init queue
  //
  __init__() {
    let CHECK_INTERVAL = 500;

    this.__redis__ = new Redis(this.__redis_url__, { enableOfflineQueue: false });

    this.__redis__.defineCommand('transaction', { lua: redisIf.script, numberOfKeys: 0 });

    this.__redis__.on('error', err => this.emit('error', err));

    this.__redis__.once('ready', () => {
      // Start with random delay to spread requests
      // from multiple instances
      this.__timer__ = setTimeout(() => {
        // timeout and interval can be cleared by same function according to HTML
        // living standard, so keeping them as the same variable should be fine
        this.__timer__ = setInterval(() => {
          this.__tick__().catch(err => this.emit('error', err));
        }, CHECK_INTERVAL);
      }, Math.round(Math.random() * CHECK_INTERVAL));

      this.emit('ready');
    });

    this.__ready__ = new Promise(resolve => {
      this.once('ready', () => resolve(true));
    });
  }
}

module.exports = Queue;

module.exports.Error            = QueueError;
module.exports.TaskTemplate     = TaskTemplate;
module.exports.ChainTemplate    = ChainTemplate;
module.exports.GroupTemplate    = GroupTemplate;
module.exports.IteratorTemplate = IteratorTemplate;
