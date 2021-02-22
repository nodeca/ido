4.0.0 / 2021-02-22
------------------

- Node.js 14.+ required.
- Refactored iterator to avoid custom scripts use.
- Moved transaction script to separate package.
- Code cleanup (replace `Promise` with `async`).


3.0.0 / 2020-07-29
------------------

- Node 10.+ required.
- Deps bump.
- Use es6 classes where possible.
- Make `.extend()` work in inherited classes.


2.1.0 / 2020-03-17
------------------

- Deps bump.
- Improve tests.


2.0.0 / 2017-07-04
------------------

- Switch to native async/await. Now requires node v7.+ to run.


1.2.3 / 2017-07-04
------------------

- Fix Queue.cancel crash when some child tasks are already finished.


1.2.2 / 2017-04-17
------------------

- Simplify children init from chain/group inherited tasks.


1.2.1 / 2017-03-29
------------------

- Fix empty result store in chains & groups.


1.2.0 / 2017-03-16
------------------

- Add API method to force task restart, #2.
- Implemented active chunks tracking for iterators.


1.1.1 / 2017-03-03
------------------

- Quick-fix to suppress events from iterator's children when
  parent was canceled.


1.1.0 / 2017-02-27
------------------

- Simplify extending group/chain task via `.init()` method override.


1.0.1 / 2017-02-07
------------------

- Fix `task:end` event emit on task cancel (for nested tasks).


1.0.0 / 2016-11-04
------------------

- First release.
