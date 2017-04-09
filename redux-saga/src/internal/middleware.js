import { noop, is, check, uid as nextSagaId, wrapSagaDispatch, isDev, log } from './utils'
import proc from './proc'
import { emitter } from './channel'
import { ident } from './utils'

export default function sagaMiddlewareFactory(options = {}) {
  let runSagaDynamically
  const {sagaMonitor} = options

  // monitors are expected to have a certain interface, let's fill-in any missing ones
  if(sagaMonitor) {
    sagaMonitor.effectTriggered = sagaMonitor.effectTriggered || noop
    sagaMonitor.effectResolved = sagaMonitor.effectResolved || noop
    sagaMonitor.effectRejected = sagaMonitor.effectRejected || noop
    sagaMonitor.effectCancelled = sagaMonitor.effectCancelled || noop
    sagaMonitor.actionDispatched = sagaMonitor.actionDispatched || noop
  }

  if(is.func(options)) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Saga middleware no longer accept Generator functions. Use sagaMiddleware.run instead');
    } else {
      throw new Error(`You passed a function to the Saga middleware. You are likely trying to start a\
        Saga by directly passing it to the middleware. This is no longer possible starting from 0.10.0.\
        To run a Saga, you must do it dynamically AFTER mounting the middleware into the store.
        Example:
          import createSagaMiddleware from 'redux-saga'
          ... other imports

          const sagaMiddleware = createSagaMiddleware()
          const store = createStore(reducer, applyMiddleware(sagaMiddleware))
          sagaMiddleware.run(saga, ...args)
      `)
    }

  }

  if(options.logger && !is.func(options.logger)) {
    throw new Error('`options.logger` passed to the Saga middleware is not a function!')
  }

  if(options.onerror) {
    if(isDev) log('warn', '`options.onerror` is deprecated. Use `options.onError` instead.')
    options.onError = options.onerror
    delete options.onerror
  }

  if(options.onError && !is.func(options.onError)) {
    throw new Error('`options.onError` passed to the Saga middleware is not a function!')
  }

  if(options.emitter && !is.func(options.emitter)) {
    throw new Error('`options.emitter` passed to the Saga middleware is not a function!')
  }

  function sagaMiddleware({getState, dispatch}) {
    runSagaDynamically = runSaga

    //全局建立一个 事件收发， 用于监控当前发起的actioon,
    //和通知我们利用具体的take去执行它们监听的任务
    const sagaEmitter = emitter()  // 这个是非常重要的，前后链接的纽带
    sagaEmitter.emit = (options.emitter || ident)(sagaEmitter.emit)

    //给每个action 添加一个SAGA_ACTION的标志---代理模式
    //什么情况下的action会带上 SAGA_ACTION 这个标志呢？
    //即利用saga里面的sagaDispatch分发的action会带上这个标志, 就是从saga里面分发的
    //action会带上这个歌标志，但是从外面往分发action的不会带上
    const sagaDispatch = wrapSagaDispatch(dispatch)

    function runSaga(saga, args, sagaId) {
      return proc(
        saga(...args),
        sagaEmitter.subscribe,
        sagaDispatch,
        getState,
        options,
        sagaId,
        saga.name
      )
    }

    return next => action => {
      if(sagaMonitor) {
        sagaMonitor.actionDispatched(action)
      }

      const result = next(action) // hit reducers

      console.log(action);


      // 每当外面触发一个action的时候，就 触发异常全局的 emitter
      // 其实它就是触发那些saga里面监听的take  这是前后链接的纽带 必须弄清楚
      sagaEmitter.emit(action)
      return result
    }
  }

  sagaMiddleware.run = (saga, ...args) => {
    check(runSagaDynamically, is.notUndef, 'Before running a Saga, you must mount the Saga middleware on the Store using applyMiddleware')
    check(saga, is.func, 'sagaMiddleware.run(saga, ...args): saga argument must be a Generator function!')

    const effectId = nextSagaId()
    if(sagaMonitor) {
      sagaMonitor.effectTriggered({effectId , root: true, parentEffectId: 0, effect: {root: true, saga, args}})
    }
    const task = runSagaDynamically(saga, args, effectId)
    if(sagaMonitor) {
      sagaMonitor.effectResolved(effectId, task)
    }
    return task
  }

  return sagaMiddleware
}
