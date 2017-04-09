import { noop, kTrue, is, log as _log, check, deferred, uid as nextEffectId, remove, TASK, CANCEL, SELF_CANCELLATION, makeIterator, isDev } from './utils'
import { asap, suspend, flush } from './scheduler'
import { asEffect } from './io'
import { stdChannel as _stdChannel, eventChannel, isEnd } from './channel'
import { buffers } from './buffers'

export const NOT_ITERATOR_ERROR = 'proc first argument (Saga function result) must be an iterator'

export const CHANNEL_END = {toString() { return '@@redux-saga/CHANNEL_END' }}
export const TASK_CANCEL = {toString() { return '@@redux-saga/TASK_CANCEL' }}

//策略模式
const matchers = {
  wildcard  : () => kTrue,
  default   : pattern => input => input.type === (typeof pattern === 'symbol' ? pattern : String(pattern)),
  array     : patterns => input => patterns.some(p => matcher(p)(input)),
  predicate : predicate => input => predicate(input)
}

//直接返回匹配结果
function matcher(pattern) {
  return (
      pattern === '*'            ? matchers.wildcard
    : is.array(pattern)          ? matchers.array
    : is.stringableFunc(pattern) ? matchers.default
    : is.func(pattern)           ? matchers.predicate
    : matchers.default
  )(pattern)
}

/**
  Used to track a parent task and its forks
  In the new fork model, forked tasks are attached by default to their parent
  We model this using the concept of Parent task && main Task
  main task is the main flow of the current Generator, the parent tasks is the
  aggregation of the main tasks + all its forked tasks.
  Thus the whole model represents an execution tree with multiple branches (vs the
  linear execution tree in sequential (non parallel) programming)

  A parent tasks has the following semantics
  - It completes if all its forks either complete or all cancelled
  - If it's cancelled, all forks are cancelled as well
  - It aborts if any uncaught error bubbles up from forks
  - If it completes, the return value is the one returned by the main task

  好好理解一下上面的意思，总结是 一个父任务下面管着主任务和fork处理的任务, 
  主任务相当于当前generator的主干往下执行，fork想当于后台异步执行
**/

// 这个是用来管理fork任务的，一开始，主的iterator为mainTask，代表主执行流程，
// 如果往下走有fork的话，如果当前 mainTask正在执行，那么它就把fork加入到队列
//如果mainTask不在执行，那么它就立即执行fork
// 具体看 const taskQueue = forkQueue(name, mainTask, end)--先利用rootSaga的iterator作为mainTask
// 利用runForkEffect对fork类型的task 加入到队列

function forkQueue(name, mainTask, cb) {
  let tasks = [], result, completed = false

  //初始化一个forkqueue的时候, 就是利用一个mainTask初始化
  addTask(mainTask)

  function abort(err) {
    cancelAll()
    cb(err, true)
  }

  function addTask(task) {
    tasks.push(task)

    //每个task在加入当前这个forkQueue的时候，都会为他们加上一个
    //和当前forkQueue "关联函数", 比如这个task 执行完成的时候
    //可以调用这个cont用来通知 parent task 对这个task
    //进行删除 如果这个task发生了错误, 那么通知parent task 对整个
    // forkqueue进行终止 --看上面的说明 It aborts if any uncaught error bubbles up from forks 
    task.cont = (res, isErr) => {
      if(completed) {
        return
      }

      //把task从当前
      remove(tasks, task)
      task.cont = noop
      //错误的话 进行终止
      if(isErr) {
        abort(res)
      } else {

        //mainTask完成的时候
        if(task === mainTask) {
          //当前为主任务的话，那赋值给 result
          //看说明: If it completes, the return value is the one returned by the main task
          result = res
        }
        //当前forkqueue已经全部完成了以后 调用回调函数
        // 应该是每个task完成的时候，都会调用 cont 然后把自己进行移除
        // 规则:It completes if all its forks either complete or all cancelled
        //当前全部完成了 即length == 0
        if(!tasks.length) {
          completed = true
          //调用 整个taskQueue完成后的回调
          cb(result)
        }
      }
    }
    // task.cont.cancel = task.cancel
  }

  function cancelAll() {
    if(completed) {
      return
    }
    completed = true
    tasks.forEach(t => {
      //cont是 task自己用来通知 parent task的, 置为空
      t.cont = noop
      //每个 应该都有自己的cancel函数, 用于取消这个任务
      t.cancel()
    })
    tasks = []
  }

  return {
    addTask,
    cancelAll,
    abort,
    getTasks: () => tasks,
    taskNames: () => tasks.map(t => t.name)
  }
}

//把一个函数生成一个迭代器, 基本就是把生成器函数执行 然后得到迭代器 进行返回
function createTaskIterator({context, fn, args}) {
  if (is.iterator(fn)) {
    return fn
  }

  // catch synchronous failures; see #152 and #441
  let result, error
  try {
    //调用函数
    result = fn.apply(context, args)
  } catch(err) {
    error = err
  }

  // i.e. a generator function returns an iterator
  //如果这个 函数返回的是一个迭代器的话，就直接把结果返回
  if (is.iterator(result)) {
    return result
  }

  // do not bubble up synchronous failures for detached forks
  // instead create a failed task. See #152 and #441
  return error
    ? makeIterator(() => { throw error })
    : makeIterator((function() {
        let pc
        const eff = {done: false, value: result}
        const ret = value => ({done: true, value})
        return arg => {
          if(!pc) {
            pc = true
            return eff
          } else {
            return ret(arg)
          }
        }
      })())
}

const wrapHelper = (helper) => ({ fn: helper })

export default function proc(
  iterator,
  subscribe = () => noop,
  dispatch = noop,
  getState = noop,
  options = {},
  parentEffectId = 0,
  name = 'anonymous',
  cont
) {
  check(iterator, is.iterator, NOT_ITERATOR_ERROR)

  const {sagaMonitor, logger, onError} = options
  const log = logger || _log

  //每个 进程都建立一个管道
  // 通过阅读channel.js代码可以知道，这里立即订阅一个函数
  // 这个函数作用是: 对发起的action 进行监控， 判断是否是从 redux-saga发起的action
  //是的话，就cb(input即action) 即把action加入到channel的buffer中
  //不是的话，先利用 schedule 进行控制，然后加入的buffer中

  const stdChannel = _stdChannel(subscribe)
  /**
    Tracks the current effect cancellation
    Each time the generator progresses. calling runEffect will set a new value
    on it. It allows propagating cancellation to child effects
  **/
  //好好理解一下这个cancnel作用, next的话 在遍历器中常用的设计方式
  next.cancel = noop

  /**
    Creates a new task descriptor for this generator, We'll also create a main task
    to track the main flow (besides other forked tasks)
  **/
  const task = newTask(parentEffectId, name, iterator, cont)
  const mainTask = {name, cancel: cancelMain, isRunning: true}
  const taskQueue = forkQueue(name, mainTask, end)

  /**
    cancellation of the main task. We'll simply resume the Generator with a Cancel
  **/
  //每个task对应的cancel方法 查看taskQueeu中 看看其在哪里使用
  function cancelMain() {
    if(mainTask.isRunning && !mainTask.isCancelled) {
      mainTask.isCancelled = true
      // 下一步就直接取消 generator执行
      next(TASK_CANCEL)
    }
  }

  /**
    This may be called by a parent generator to trigger/propagate cancellation
    cancel all pending tasks (including the main task), then end the current task.

    Cancellation propagates down to the whole execution tree holded by this Parent task
    It's also propagated to all joiners of this task and their execution tree/joiners

    Cancellation is noop for terminated/Cancelled tasks tasks
  **/

  //当前 saga iterator 取消
  function cancel() {
    /**
      We need to check both Running and Cancelled status
      Tasks can be Cancelled but still Running
    **/

    //当前主的 generator iterator 取消的话，就取消forkQueue里面的所有任务
    if(iterator._isRunning && !iterator._isCancelled) {
      iterator._isCancelled = true
      //每个task都执行自己的cacnel方法 而且将自己从taskQueeu移除
      taskQueue.cancelAll()
      /**
        Ending with a Never result will propagate the Cancellation to all joiners
      **/
      end(TASK_CANCEL)
    }
  }
  /**
    attaches cancellation logic to this task's continuation
    this will permit cancellation to propagate down the call chain
  **/
  cont && (cont.cancel = cancel)

  // tracks the running status
  iterator._isRunning = true

  // kicks up the generator
  next()

  // then return the task descriptor to the caller
  // 注意 这里返回的是task, 也就是说一个 task是一个 proc.js产生呢？
  //哪些情况下会产生一个新的task呢？ 两种情况 一种是 rootSata 一种是fork
  return task

  /**
    This is the generator driver
    It's a recursive async/continuation function which calls itself
    until the generator terminates or throws
  **/
  function next(arg, isErr) {
    // Preventive measure. If we end up here, then there is really something wrong
    if(!mainTask.isRunning) {
      throw new Error('Trying to resume an already finished generator')
    }

    try {
      let result
      if(isErr) {
        //出错的的时候 往iterator里面抛异常
        result = iterator.throw(arg)
      } else if(arg === TASK_CANCEL) {
        /**
          getting TASK_CANCEL automatically cancels the main task
          We can get this value here

          - By cancelling the parent task manually
          - By joining a Cancelled task
        **/
        mainTask.isCancelled = true
        /**
          Cancels the current effect; this will propagate the cancellation down to any called tasks
        **/
        next.cancel()
        /**
          If this Generator has a `return` method then invokes it
          Thill will jump to the finally block
        **/
        result = is.func(iterator.return) ? iterator.return(TASK_CANCEL) : {done: true, value: TASK_CANCEL}
      } else if(arg === CHANNEL_END) {
        // We get CHANNEL_END by taking from a channel that ended using `take` (and not `takem` used to trap End of channels)
        result = is.func(iterator.return) ? iterator.return() : {done: true}
      } else {
        //迭代器往下走---真正调用iterator的next arg把处理的值传递过去
        result = iterator.next(arg)
      }

      if(!result.done) {
         //最后一个参数为 next 当前的生成器往下执行
         runEffect(result.value, parentEffectId, '', next)
      } else {
        /**
          This Generator has ended, terminate the main task and notify the fork queue
        **/
        mainTask.isMainRunning = false
        //触发 task的 cont函数 用来通知forkQueue告知这个forkQueue自己执行完成了
        //可以把它进行移除
        mainTask.cont && mainTask.cont(result.value)
      }
    } catch(error) {
      if(mainTask.isCancelled) {
        log('error', `uncaught at ${name}`, error.message)
      }
      mainTask.isMainRunning = false
      mainTask.cont(error, true)
    }
  }

  function end(result, isErr) {
    iterator._isRunning = false
    stdChannel.close()
    if(!isErr) {
      if(result === TASK_CANCEL && isDev) {
        log('info', `${name} has been cancelled`, '')
      }
      iterator._result = result
      iterator._deferredEnd && iterator._deferredEnd.resolve(result)
    } else {
      if(result instanceof Error) {
        result.sagaStack = `at ${name} \n ${result.sagaStack || result.stack}`
      }
      if(!task.cont) {
        log('error', `uncaught`, result.sagaStack || result.stack)
        if((result instanceof Error) && onError) {
          onError(result)
        }
      }
      iterator._error = result
      iterator._isAborted = true
      iterator._deferredEnd && iterator._deferredEnd.reject(result)
    }
    task.cont && task.cont(result, isErr)
    //task joiners从哪里来？
    task.joiners.forEach(j => j.cb(result, isErr))
    task.joiners = null
  }

  function runEffect(effect, parentEffectId, label = '', cb) {
    const effectId = nextEffectId()
    sagaMonitor && sagaMonitor.effectTriggered({effectId, parentEffectId, label, effect})

    /**
      completion callback and cancel callback are mutually exclusive
      We can't cancel an already completed effect
      And We can't complete an already cancelled effectId
    **/
    let effectSettled

    // Completion callback passed to the appropriate effect runner

    //可以理解为代理模式吧 实际调用的就是 cb 只是中途需要代理添加了一下逻辑
    function currCb(res, isErr) {
      if(effectSettled) {
        return
      }

      effectSettled = true
      cb.cancel = noop // defensive measure
      if(sagaMonitor) {
        isErr ?
          sagaMonitor.effectRejected(effectId, res)
        : sagaMonitor.effectResolved(effectId, res)
      }

      cb(res, isErr)
    }
    // tracks down the current cancel
    currCb.cancel = noop

    // setup cancellation logic on the parent cb
    cb.cancel = () => {
      // prevents cancelling an already completed effect
      if(effectSettled) {
        return
      }

      effectSettled = true
      /**
        propagates cancel downward
        catch uncaught cancellations errors; since we can no longer call the completion
        callback, log errors raised during cancellations into the console
      **/
      try {
        currCb.cancel()
      } catch(err) {
        log('error', `uncaught at ${name}`, err.message)
      }
      currCb.cancel = noop // defensive measure

      sagaMonitor && sagaMonitor.effectCancelled(effectId)
    }

    /**
      each effect runner must attach its own logic of cancellation to the provided callback
      it allows this generator to propagate cancellation downward.

      ATTENTION! effect runners must setup the cancel logic by setting cb.cancel = [cancelMethod]
      And the setup must occur before calling the callback

      This is a sort of inversion of control: called async functions are responsible
      of completing the flow by calling the provided continuation; while caller functions
      are responsible for aborting the current flow by calling the attached cancel function

      Library users can attach their own cancellation logic to promises by defining a
      promise[CANCEL] method in their returned promises
      ATTENTION! calling cancel must have no effect on an already completed or cancelled effect
    **/
    let data
    return (
      // Non declarative effect
        is.promise(effect)                                   ? resolvePromise(effect, currCb)
      : is.helper(effect)                                    ? runForkEffect(wrapHelper(effect), effectId, currCb)
      : is.iterator(effect)                                  ? resolveIterator(effect, effectId, name, currCb)

      // declarative effects

      // 这里的这个data呢 实际就是 effect里面的payload!!!

      : is.array(effect)                                     ? runParallelEffect(effect, effectId, currCb)
      : (is.notUndef(data = asEffect.take(effect)))          ? runTakeEffect(data, currCb)
      : (is.notUndef(data = asEffect.put(effect)))           ? runPutEffect(data, currCb)
      : (is.notUndef(data = asEffect.race(effect)))          ? runRaceEffect(data, effectId, currCb)
      : (is.notUndef(data = asEffect.call(effect)))          ? runCallEffect(data, effectId, currCb)
      : (is.notUndef(data = asEffect.cps(effect)))           ? runCPSEffect(data, currCb)
      : (is.notUndef(data = asEffect.fork(effect)))          ? runForkEffect(data, effectId, currCb)
      : (is.notUndef(data = asEffect.join(effect)))          ? runJoinEffect(data, currCb)
      : (is.notUndef(data = asEffect.cancel(effect)))        ? runCancelEffect(data, currCb)
      : (is.notUndef(data = asEffect.select(effect)))        ? runSelectEffect(data, currCb)
      : (is.notUndef(data = asEffect.actionChannel(effect))) ? runChannelEffect(data, currCb)
      : (is.notUndef(data = asEffect.flush(effect)))         ? runFlushEffect(data, currCb)
      : (is.notUndef(data = asEffect.cancelled(effect)))     ? runCancelledEffect(data, currCb)
      : /* anything else returned as is        */              currCb(effect)
    )
  }

  function resolvePromise(promise, cb) {
    const cancelPromise = promise[CANCEL]
    if(typeof cancelPromise === 'function') {
      cb.cancel = cancelPromise
    }
    promise.then(
      cb,
      error => cb(error, true)
    )
  }

  function resolveIterator(iterator, effectId, name, cb) {
    proc(iterator, subscribe, dispatch, getState, options, effectId, name, cb)
  }

  function runTakeEffect({channel, pattern, maybe}, cb) {
    channel = channel || stdChannel
    //第一个参数为input 为action  或者其他出错的情况
    //take函数 实际就是 生成器中的 next 执行这个next 生成器往下走
    const takeCb = inp => (
        inp instanceof Error  ? cb(inp, true)
      : isEnd(inp) && !maybe ? cb(CHANNEL_END)
      : cb(inp)
    )
    try {
      //把 takeCb放入管道的takes中  channel.js中的181
      //matcher(Patcher) 自己返回true /false
      channel.take(takeCb, matcher(pattern))
    } catch(err) {
      return cb(err, true)
    }
    cb.cancel = takeCb.cancel
  }

  function runPutEffect({channel, action, resolve}, cb) {
    /**
      Schedule the put in case another saga is holding a lock.
      The put will be executed atomically. ie nested puts will execute after
      this put has terminated.
    **/
    asap(() => {
      let result
      try {
        result = (channel ? channel.put : dispatch)(action)
      } catch(error) {
        // If we have a channel or `put.resolve` was used then bubble up the error.
        if (channel || resolve) return cb(error, true)
        log('error', `uncaught at ${name}`, error.stack || error.message || error)
      }

      if(resolve && is.promise(result)) {
        resolvePromise(result, cb)
      } else {
        return cb(result)
      }
    })
    // Put effects are non cancellables
  }

  function runCallEffect({context, fn, args}, effectId, cb) {
    let result
    // catch synchronous failures; see #152
    try {
      result = fn.apply(context, args)
    } catch(error) {
      return cb(error, true)
    }
    return (
        is.promise(result)  ? resolvePromise(result, cb)
      : is.iterator(result) ? resolveIterator(result, effectId, fn.name, cb)
      : cb(result)
    )
  }

  function runCPSEffect({context, fn, args}, cb) {
    // CPS (ie node style functions) can define their own cancellation logic
    // by setting cancel field on the cb

    // catch synchronous failures; see #152
    try {
      const cpsCb = (err, res) => is.undef(err) ? cb(res) : cb(err, true);
      fn.apply(context, args.concat(cpsCb));
      if (cpsCb.cancel) {
        cb.cancel = () => cpsCb.cancel();
      }
    } catch(error) {
      return cb(error, true)
    }
  }

  function runForkEffect({context, fn, args, detached}, effectId, cb) {

    //fork会执行一个generator函数调用 fork(authorize, user, password)
    //它会自己也创建一个独立的生成器执行系统(task) 即有自己的stdChannel等
    //利用proc.js创建
    const taskIterator = createTaskIterator({context, fn, args})

    try {
      suspend()

      //对每个fork类型都创建一个proc即 task
      //它里面有自己的 channel
      const task = proc(taskIterator, subscribe, dispatch, getState, options, effectId, fn.name, (detached ? null : noop))

      // fork如何做到不阻塞的呢？ cb实际就是它对应的上一个所在生成器里面的next
      if(detached) {
        //如果当前为独立fork， 直接cb(task) 即 直接执行next 生成器不就理解往下走了么 这样
        //就能立即做到不阻塞了
        cb(task)
      } else {
        if(taskIterator._isRunning) {

          //如果当前 mainTaskIterator还正在执行的话，那么就把这个task
          //加入到自己目前对应的父的taskQueue中
          taskQueue.addTask(task)
          cb(task) //如何在立即往下走
        } else if(taskIterator._error) {  //父的mainTask出错了，那么父的taskQueue就全部终止
          taskQueue.abort(taskIterator._error)
        } else {
          cb(task)
        }
      }
    } finally {
      flush()
    }
    // Fork effects are non cancellables
  }

  function runJoinEffect(t, cb) {
    if(t.isRunning()) {
      const joiner = {task, cb}
      cb.cancel = () => remove(t.joiners, joiner)
      t.joiners.push(joiner)
    } else {
      t.isAborted() ? cb(t.error(), true) : cb(t.result())
    }
  }

  function runCancelEffect(taskToCancel, cb) {
    if (taskToCancel === SELF_CANCELLATION) {
      taskToCancel = task
    }
    if(taskToCancel.isRunning()) {
      taskToCancel.cancel()
    }
    cb()
    // cancel effects are non cancellables
  }

  function runParallelEffect(effects, effectId, cb) {
    if(!effects.length) {
      return cb([])
    }

    let completedCount = 0
    let completed
    const results = Array(effects.length)

    function checkEffectEnd() {
      if(completedCount === results.length) {
        completed = true
        cb(results)
      }
    }

    const childCbs = effects.map((eff, idx) => {
        const chCbAtIdx = (res, isErr) => {
          if(completed) {
            return
          }
          if(isErr || isEnd(res) || res === CHANNEL_END || res === TASK_CANCEL) {
            cb.cancel()
            cb(res, isErr)
          } else {
            results[idx] = res
            completedCount++
            checkEffectEnd()
          }
        }
        chCbAtIdx.cancel = noop
        return chCbAtIdx
    })

    cb.cancel = () => {
      if(!completed) {
        completed = true
        childCbs.forEach(chCb => chCb.cancel())
      }
    }

    effects.forEach((eff, idx) => runEffect(eff, effectId, idx, childCbs[idx]))
  }

  function runRaceEffect(effects, effectId, cb) {
    let completed
    const keys = Object.keys(effects)
    const childCbs = {}

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if(completed) {
          return
        }

        if(isErr) {
          // Race Auto cancellation
          cb.cancel()
          cb(res, true)
        } else if(!isEnd(res) && res !== CHANNEL_END && res !== TASK_CANCEL) {
          cb.cancel()
          completed = true
          cb({[key]: res})
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      // prevents unnecessary cancellation
      if(!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }
    keys.forEach(key => {
      if(completed) {
        return
      }
      runEffect(effects[key], effectId, key, childCbs[key])
    })
  }

  function runSelectEffect({selector, args}, cb) {
    try {
      const state = selector(getState(), ...args)
      cb(state)
    } catch(error) {
      cb(error, true)
    }
  }

  function runChannelEffect({pattern, buffer}, cb) {
    const match = matcher(pattern)
    match.pattern = pattern
    cb(eventChannel(subscribe, buffer || buffers.fixed(), match))
  }

  function runCancelledEffect(data, cb) {
    cb(!!mainTask.isCancelled)
  }

  function runFlushEffect(channel, cb) {
    channel.flush(cb)
  }

  function newTask(id, name, iterator, cont) {
    iterator._deferredEnd = null
    return {
      [TASK]: true,
      id,
      name,
      get done() {
        if(iterator._deferredEnd) {
          return iterator._deferredEnd.promise
        } else {
          const def = deferred()
          iterator._deferredEnd = def
          if(!iterator._isRunning) {
            iterator._error ? def.reject(iterator._error) : def.resolve(iterator._result)
          }
          return def.promise
        }
      },
      cont,
      joiners: [],
      cancel,
      isRunning: () => iterator._isRunning,
      isCancelled: () => iterator._isCancelled,
      isAborted: () => iterator._isAborted,
      result: () => iterator._result,
      error: () => iterator._error
    }
  }
}
