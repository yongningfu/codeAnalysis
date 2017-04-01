import hoistStatics from 'hoist-non-react-statics'
import invariant from 'invariant'
import { Component, createElement } from 'react'

import Subscription from '../utils/Subscription'
import { storeShape, subscriptionShape } from '../utils/PropTypes'

let hotReloadingVersion = 0
const dummyState = {}
function noop() {}
function makeSelectorStateful(sourceSelector, store) {
  // wrap the selector in an object that tracks its results between runs.
  const selector = {
    run: function runComponentSelector(props) {
      try {

        // 当前的状态 + ownprops 得到下一个状态
        //https://github.com/reactjs/react-redux/blob/master/src/connect/selectorFactory.js#L9
        // sourceSelect为 impureFinalPropsSelector
        /*
        return mergeProps(
          mapStateToProps(state, ownProps),
          mapDispatchToProps(dispatch, ownProps),
          ownProps
        )
        
         */

        //默认使用的merge方式为 https://github.com/reactjs/react-redux/blob/master/src/connect/mergeProps.js#L3
        // 即 
        /*
        export function defaultMergeProps(stateProps, dispatchProps, ownProps) {
          return { ...ownProps, ...stateProps, ...dispatchProps }
        }
        
        */

        const nextProps = sourceSelector(store.getState(), props)

        //由于默认的方式下，一定会生成新的 nextProps 对象，所以nextProps !== selector.props
        //这句话在默认下根本就没用， 考虑优化的话，可以在这里考虑 ！！！
        // 比如我们可以在  "容器"组件的shouldComponentUpdate里面进行 深度比较

        //如果不同的话，就更新
        if (nextProps !== selector.props || selector.error) {
          //设置更新的标志
          selector.shouldComponentUpdate = true
          selector.props = nextProps
          selector.error = null
        }
      } catch (error) {
        //出错的话 也更新
        selector.shouldComponentUpdate = true
        selector.error = error
      }
    }
  }

  //selector上面记录 组件的属性 和 组件是否更新
  return selector
}

export default function connectAdvanced(
  /*
    selectorFactory is a func that is responsible for returning the selector function used to
    compute new props from state, props, and dispatch. For example:

      export default connectAdvanced((dispatch, options) => (state, props) => ({
        thing: state.things[props.thingId],
        saveThing: fields => dispatch(actionCreators.saveThing(props.thingId, fields)),
      }))(YourComponent)

    Access to dispatch is provided to the factory so selectorFactories can bind actionCreators
    outside of their selector as an optimization. Options passed to connectAdvanced are passed to
    the selectorFactory, along with displayName and WrappedComponent, as the second argument.

    Note that selectorFactory is responsible for all caching/memoization of inbound and outbound
    props. Do not use connectAdvanced directly without memoizing results between calls to your
    selector, otherwise the Connect component will re-render on every state or props change.
  */
  selectorFactory,
  // options object:
  {
    // the func used to compute this HOC's displayName from the wrapped component's displayName.
    // probably overridden by wrapper functions such as connect()
    getDisplayName = name => `ConnectAdvanced(${name})`,

    // shown in error messages
    // probably overridden by wrapper functions such as connect()
    methodName = 'connectAdvanced',

    // if defined, the name of the property passed to the wrapped element indicating the number of
    // calls to render. useful for watching in react devtools for unnecessary re-renders.
    renderCountProp = undefined,

    // determines whether this HOC subscribes to store changes
    shouldHandleStateChanges = true,

    // the key of props/context to get the store
    storeKey = 'store',

    // if true, the wrapped element is exposed by this HOC via the getWrappedInstance() function.
    withRef = false,

    // additional options are passed through to the selectorFactory
    ...connectOptions
  } = {}
) {
  const subscriptionKey = storeKey + 'Subscription'
  const version = hotReloadingVersion++

  const contextTypes = {
    [storeKey]: storeShape,
    [subscriptionKey]: subscriptionShape,
  }
  const childContextTypes = {
    [subscriptionKey]: subscriptionShape,
  }

  return function wrapWithConnect(WrappedComponent) {
    invariant(
      typeof WrappedComponent == 'function',
      `You must pass a component to the function returned by ` +
      `connect. Instead received ${JSON.stringify(WrappedComponent)}`
    )

    const wrappedComponentName = WrappedComponent.displayName
      || WrappedComponent.name
      || 'Component'

    const displayName = getDisplayName(wrappedComponentName)

    const selectorFactoryOptions = {
      ...connectOptions,
      getDisplayName,
      methodName,
      renderCountProp,
      shouldHandleStateChanges,
      storeKey,
      withRef,
      displayName,
      wrappedComponentName,
      WrappedComponent
    }

    class Connect extends Component {
      constructor(props, context) {
        super(props, context)

        this.version = version
        this.state = {}
        this.renderCount = 0
        this.store = props[storeKey] || context[storeKey]
        this.propsMode = Boolean(props[storeKey])
        this.setWrappedInstance = this.setWrappedInstance.bind(this)

        invariant(this.store,
          `Could not find "${storeKey}" in either the context or props of ` +
          `"${displayName}". Either wrap the root component in a <Provider>, ` +
          `or explicitly pass "${storeKey}" as a prop to "${displayName}".`
        )

        this.initSelector()
        this.initSubscription()
      }

      getChildContext() {
        // If this component received store from props, its subscription should be transparent
        // to any descendants receiving store+subscription from context; it passes along
        // subscription passed to it. Otherwise, it shadows the parent subscription, which allows
        // Connect to control ordering of notifications to flow top-down.
        const subscription = this.propsMode ? null : this.subscription
        return { [subscriptionKey]: subscription || this.context[subscriptionKey] }
      }

      
      componentDidMount() {
        if (!shouldHandleStateChanges) return

        // componentWillMount fires during server side rendering, but componentDidMount and
        // componentWillUnmount do not. Because of this, trySubscribe happens during ...didMount.
        // Otherwise, unsubscription would never take place during SSR, causing a memory leak.
        // To handle the case where a child component may have triggered a state change by
        // dispatching an action in its componentWillMount, we have to re-run the select and maybe
        // re-render.


        //订阅组件的 onStateChange 函数
        this.subscription.trySubscribe()


        //https://github.com/reactjs/react-redux/blob/master/src/components/connectAdvanced.js#L14
        //selector run里面做的是 取得组件下一次的props, 然后判断是否相同，不同则 forceUpdate
        this.selector.run(this.props)
        if (this.selector.shouldComponentUpdate) this.forceUpdate()
      }

      componentWillReceiveProps(nextProps) {
        this.selector.run(nextProps)
      }

      shouldComponentUpdate() {
        return this.selector.shouldComponentUpdate
      }

      componentWillUnmount() {

        //容器组件卸载后，取消当前的订阅
        if (this.subscription) this.subscription.tryUnsubscribe()
        this.subscription = null
        this.notifyNestedSubs = noop
        this.store = null
        this.selector.run = noop
        //设置为不可以更新---！！！这个也是为什么，redux管理下的Connect容器组件 调用异步
        //异步里面有setState，然后理解退出，这个时候异步还没完成，但是组件已经unmount了，
        //而组件并没有发生 在unmount组件上面使用setState错误的原因 ！！！
        this.selector.shouldComponentUpdate = false
      }

      getWrappedInstance() {
        invariant(withRef,
          `To access the wrapped instance, you need to specify ` +
          `{ withRef: true } in the options argument of the ${methodName}() call.`
        )
        return this.wrappedInstance
      }

      setWrappedInstance(ref) {
        this.wrappedInstance = ref
      }

      initSelector() {
        // selectorFactories 默认使用的是 impureFinalPropsSelectorFactory 在
        // https://github.com/reactjs/react-redux/blob/master/src/connect/selectorFactory.js#L3
        // 不纯的propsSelectorFactor
        // 返回函数 impureFinalPropsSelector 即 sourceSelector

        const sourceSelector = selectorFactory(this.store.dispatch, selectorFactoryOptions)
        this.selector = makeSelectorStateful(sourceSelector, this.store)
        this.selector.run(this.props)
      }

      initSubscription() {
        if (!shouldHandleStateChanges) return

        // parentSub's source should match where store came from: props vs. context. A component
        // connected to the store via props shouldn't use subscription from context, or vice versa.
        const parentSub = (this.propsMode ? this.props : this.context)[subscriptionKey]

        //在Connect组件里面新建一个Subscription
        this.subscription = new Subscription(this.store, parentSub, this.onStateChange.bind(this))

        // `notifyNestedSubs` is duplicated to handle the case where the component is  unmounted in
        // the middle of the notification loop, where `this.subscription` will then be null. An
        // extra null check every change can be avoided by copying the method onto `this` and then
        // replacing it with a no-op on unmount. This can probably be avoided if Subscription's
        // listeners logic is changed to not call listeners that have been unsubscribed in the
        // middle of the notification loop.
        this.notifyNestedSubs = this.subscription.notifyNestedSubs.bind(this.subscription)
      }


      //Connect组件的onStateChange函数 这个是理解的关键 ！！！
      //关键是什么时候会调用这个函数 在哪里调用
      //最核心的代码 还是在 Subscription.js里面
      //https://github.com/reactjs/react-redux/blob/master/src/utils/Subscription.js#L69
      /*
      trySubscribe() {
        if (!this.unsubscribe) {
          this.unsubscribe = this.parentSub
            ? this.parentSub.addNestedSub(this.onStateChange)
            : this.store.subscribe(this.onStateChange)
    
          this.listeners = createListenerCollection()
        }
      }
      
      看到上面 trySubscribe定义了么？ 如果一个一个Connect组件的 父订阅对象不存在, 那么
      它实际是把订阅挂载到 redux的store里面去的，也就是说  整个流程为
      当redux dispatch 发起action的时候， 会去触发redux订阅的函数，即顶层的容器Connect组件的
      onStateChange函数， 整个函数触发的话，会先判读 当前这个Connect组件是否能更新(不能更新的情况有
      一个组件已经Unmount了，它是用一个selector对象进行记录的), 如果不能更新的话，这个Connect组件会往下
      触发子Connect组件的onStateChange函数，如果能更新的话，先给自己的ComponentDidUpdate组件赋值为
      notifyNestedSubs 即触发自己子组件的 onStateChange函数，然后触发 setState，由于react的声明周期，
      Connect下面的子Connect会在当前Connect更新完成后，再触发更新。

       */
      onStateChange() {
        this.selector.run(this.props)

        if (!this.selector.shouldComponentUpdate) {
          this.notifyNestedSubs()
        } else {
          this.componentDidUpdate = this.notifyNestedSubsOnComponentDidUpdate
          this.setState(dummyState)
        }
      }

      notifyNestedSubsOnComponentDidUpdate() {
        // `componentDidUpdate` is conditionally implemented when `onStateChange` determines it
        // needs to notify nested subs. Once called, it unimplements itself until further state
        // changes occur. Doing it this way vs having a permanent `componentDidMount` that does
        // a boolean check every time avoids an extra method call most of the time, resulting
        // in some perf boost.
        this.componentDidUpdate = undefined
        this.notifyNestedSubs()
      }

      isSubscribed() {
        return Boolean(this.subscription) && this.subscription.isSubscribed()
      }

      addExtraProps(props) {
        if (!withRef && !renderCountProp && !(this.propsMode && this.subscription)) return props
        // make a shallow copy so that fields added don't leak to the original selector.
        // this is especially important for 'ref' since that's a reference back to the component
        // instance. a singleton memoized selector would then be holding a reference to the
        // instance, preventing the instance from being garbage collected, and that would be bad
        const withExtras = { ...props }
        if (withRef) withExtras.ref = this.setWrappedInstance
        if (renderCountProp) withExtras[renderCountProp] = this.renderCount++
        if (this.propsMode && this.subscription) withExtras[subscriptionKey] = this.subscription
        return withExtras
      }

      render() {
        const selector = this.selector
        selector.shouldComponentUpdate = false

        if (selector.error) {
          throw selector.error
        } else {
          return createElement(WrappedComponent, this.addExtraProps(selector.props))
        }
      }
    }

    Connect.WrappedComponent = WrappedComponent
    Connect.displayName = displayName
    Connect.childContextTypes = childContextTypes
    Connect.contextTypes = contextTypes
    Connect.propTypes = contextTypes

    if (process.env.NODE_ENV !== 'production') {
      Connect.prototype.componentWillUpdate = function componentWillUpdate() {
        // We are hot reloading!
        if (this.version !== version) {
          this.version = version
          this.initSelector()

          if (this.subscription) this.subscription.tryUnsubscribe()
          this.initSubscription()
          if (shouldHandleStateChanges) this.subscription.trySubscribe()
        }
      }
    }

    return hoistStatics(Connect, WrappedComponent)
  }
}
