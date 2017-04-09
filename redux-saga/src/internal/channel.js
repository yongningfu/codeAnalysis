import { is, check, remove, MATCH, internalErr, SAGA_ACTION} from './utils'
import {buffers} from './buffers'
import { asap } from './scheduler'  //asap为尽快执行，其实就是将task加入执行队列

const CHANNEL_END_TYPE = '@@redux-saga/CHANNEL_END'
export const END = {type: CHANNEL_END_TYPE}
export const isEnd = a => a && a.type === CHANNEL_END_TYPE  // 判断这个对象是不是END

export function emitter() {
  const subscribers = []

  function subscribe(sub) {

    console.log(sub);
    
    subscribers.push(sub)
    return () => remove(subscribers, sub)
  }

  function emit(item) {
    const arr = subscribers.slice()
    for (var i = 0, len =  arr.length; i < len; i++) {
      arr[i](item)
    }
  }

  return {
    subscribe,
    emit
  }
}

export const INVALID_BUFFER = 'invalid buffer passed to channel factory function'
export var UNDEFINED_INPUT_ERROR = 'Saga was provided with an undefined action'

if(process.env.NODE_ENV !== 'production') {
  UNDEFINED_INPUT_ERROR += `\nHints:
    - check that your Action Creator returns a non-undefined value
    - if the Saga was started using runSaga, check that your subscribe source provides the action to its listeners
  `
}

export function channel(buffer = buffers.fixed()) {
  let closed = false

  // 这个take就是我们应用里面定于的一个个监听action的处理函数
  let takers = []

  check(buffer, is.buffer, INVALID_BUFFER)

  function checkForbiddenStates() {
    if(closed && takers.length) {
      throw internalErr('Cannot have a closed channel with pending takers')
    }
    if(takers.length && !buffer.isEmpty()) {
      throw internalErr('Cannot have pending takers with non empty buffer')
    }
  }
  
  //这个input是经过sagaDispatch改过的action
  function put(input) {
    checkForbiddenStates()
    check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
    if (closed) {
      return
    }

    //如果当前管道里面没有take的话(即没有action的处理函数)，那么就把action加入到buffer中
    if (!takers.length) {
      return buffer.put(input)
    }

    //如果有take的话，直接执行这些take
    for (var i = 0; i < takers.length; i++) {
      const cb = takers[i]

      //take里面的match函数 可以用来检测当前的action是否符合它应该处理的action
      if(!cb[MATCH] || cb[MATCH](input)) {
        takers.splice(i, 1)  //这里非常重要!!! 符合的话 执行对应的take 而且把take给删除
        return cb(input)          
      } 
    }
  }

  // 将当前的take(cb)加入takes
  function take(cb) {

    //console.log(cb);//function takeCb(inp) {
                    //· return inp instanceof Error ? cb(inp, true) : (0, _channel.isEnd)(inp) && !maybe ? cb(CHANNEL_END) : cb(inp);
                    //}

    checkForbiddenStates()
    check(cb, is.func, 'channel.take\'s callback must be a function')

    if(closed && buffer.isEmpty()) {
      cb(END)  //这里也是比较有意思的处理？？？


    // 这里的两条逻辑是 如果当前buffer里面有待执行的action
    //那么take就直接执行这个 buffer里面的最先的action就行了
    //如果当前buffer里面没有action，那么就将take放入takes中，等待action的进入

    } else if(!buffer.isEmpty()) {


      cb(buffer.take()) //buffer.take() 取出第一个action，并删除
    } else {

      //如果buffer为空的话，将take放入takes中 等待action就入就立即执行对应的take（看之前put）
      takers.push(cb)
      cb.cancel = () => remove(takers, cb)  //每个take都加入一个cancel函数，可以将自己从takers中删除
    }
  }

  function flush(cb) {
    checkForbiddenStates() // TODO: check if some new state should be forbidden now
    check(cb, is.func, 'channel.flush\' callback must be a function')
    if (closed && buffer.isEmpty()) {
      cb(END)
      return
    }
    cb(buffer.flush())
  }

  function close() {
    checkForbiddenStates()
    if(!closed) {
      closed = true
      if(takers.length) {
        const arr = takers
        takers = []

        //管道关闭的话 对每个take都执行 而且他们的参数都为END, 想想take的参数为end的话 会发生什么？？？
        for (let i = 0, len = arr.length; i < len; i++) {
          arr[i](END)
        }
      }
    }
  }

  return {take, put, flush, close,
    get __takers__() { return takers },
    get __closed__() { return closed }
  }
}

//这里的这个subscribe看的有点绕
/**
 * subscribe这个参数呢 要求它必须是一个订阅函数参数, 普通函数不可以
 * 比如上面的类似emitter.subscribe才可以
 * 
 * 这里的话，每次先建一个 eventChannel 的时候，会立即订阅一个函数
 * input => {
    if(isEnd(input)) {
      chan.close()
      return
    }
    // 利用match 来匹配action 看是否为对应的action
    if(matcher && !matcher(input)) {
      return
    }
    chan.put(input)
  }
 * 
 * 这个函数的执行意图也很明显了, input一般来说是 action对象
 * chan.put(input) 是将action加入到 管道中
 * 
 * 这样做的逻辑在何处呢？ 假设这个subscribe就是我们全局的 sagaEmitter的subscribe吧
 * 它订阅了这个函数 而且函数里面有执行 chan.put(input), 说明了啥， 没当 外部发起一个
 * action的话，就会执行sagaEmitter.emit(action), 也就是会执行  subscribe订阅的
 * input => ...chan.put(input)   这样的话， 是不是把action 加入到了管道中！！！
 * 巧妙吧！！！虽然有点绕
 * 
 * 总结一下，这样做的思想在何？ eventChannel 内部实际为一个 channel，channel内部分为
 * take 和 buffer，take消耗buffer中的数据，take实际也就是一项项任务，这里作者想要表达的是 
 * 任务从哪来  数据从哪来， 它的数据直接给subscribe 进行管理，subscribe订阅的函数(input => chan.put(input))
 * 执行，就能带来数据，(想当于从某处订阅数据源 厉害吧!!!) 
 * 至于take从哪来的话，直接就对外提供接口了，
 * 
 */
export function eventChannel(subscribe, buffer = buffers.none(), matcher) {
  /**
    should be if(typeof matcher !== undefined) instead?
    see PR #273 for a background discussion
  **/
  if(arguments.length > 2) {
    check(matcher, is.func, 'Invalid match function passed to eventChannel')
  }

  const chan = channel(buffer)
  const unsubscribe = subscribe(input => {
    if(isEnd(input)) {
      chan.close()
      return
    }
    // 利用match 来匹配action 看是否为对应的action
    if(matcher && !matcher(input)) {
      return
    }
    chan.put(input)
  })

  if(!is.func(unsubscribe)) {
    throw new Error('in eventChannel: subscribe should return a function to unsubscribe')
  }

  return {
    take: chan.take,
    flush: chan.flush,
    close: () => {
      if(!chan.__closed__) {
        chan.close()
        unsubscribe() // unsubscribe 取消订阅数据
      }
    }
  }
}


// 这个函数就更加绕了 和 前面的 eventChannel一组合起来，很难读，但是非常巧妙
/**
 * 
 * 首先 这个subscribe是什么？ 难道是订阅数据？
 * 直接看下面分析吧
 */
export function stdChannel(subscribe) {

  // 这个subscribe在源码中的使用为 全局的emitter 即middleware.js 61行注册的
  //sagaEmitter对象的subscribe
  //看 proc.js 里面的151 const stdChannel = _stdChannel(subscribe)  知道subscribe哪里传递过来


  // 这里一旦对stdChannel 初始化的话，立即给全局emitter 注册一个函数
  /*
    input => {
        if (input[SAGA_ACTION]) {

          //所以这里的动作实际为 将action put 到 channel
          cb(input)
          return
        }
        //不是SAGA_ACTION， 直接放在sheduler中执行
        asap(() => cb(input))
      }
  */
  //上面注册的这个函数什么时候调用呢？ 之前说过了，这个函数是注册在全局的emitter上面的，
  //全局的emiiter在每个action发起的时候都会调用里面的函数，这个input实际就是action
  // 看看 即middleware.js 代码就知道为何 action会有一个 SAGA_ACTION 属性了

  // 注意: cb是一个函数 那么cb是什么？
  // 对比上面的 eventChannel 的subscribe 这个函数的第一个参数为 input => {}
  // 即 cb 为 eventChannel中 subscribe里面的input => {chan.put(...)}
  // 而且这里非常巧妙， cb => subscribe() 这个subscribe是全局 emitter里面的subscribe
  // 那么恰好可以返回一个 unsubscribe
  const chan = eventChannel(cb => subscribe(input => {

    //如果是在saga内部dispath的action的话 会有SAFA_ACTION属性
    //就把它加入到 channel中
    if (input[SAGA_ACTION]) {

      //所以这里的动作实际为 将action put 到 channel(好好理解这里)
      cb(input)  //cb 就是eventChannel的subscribe参数，而且它是一个函数即 input=>chan.put(input)
      return
    }
    //不是SAGA_ACTION， 直接放在sheduler中执行 cb(input)
    asap(() => cb(input))

    //??? 为何要区分两种？？？？？？ 直接cb 和 asap cb有和不同？？

  }))

  return {
    ...chan,

    //对take进行改写  那么这个cb是什么？？？
    //在 proc.js的 417 中 我们可以看到 cb

    //调用take的时候，加入action的比较函数 比如take("async", handler) 这个take仅仅处理 type为
    //async的action
    take(cb, matcher) {
      if(arguments.length > 1) {
        check(matcher, is.func, 'channel.take\'s matcher argument must be a function')
        cb[MATCH] = matcher
      }
      chan.take(cb) //执行 或者 加入takes 
    }
  }
}
