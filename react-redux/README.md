# react-redux源码分析
起源: 之前在做react的项目的时候，由于临时要发一个异步请求，而不把这个请求放在redux管理之下，于是在componetDidMount里面发起请求，然后进行setState
```javascript
componentDidMount() {
  setTimeout(() => {
    setState({xx:yy});
  }, 2000)
}
```
请问上面的代码有问题吗？
上面的代码是有问题的， 原因在于如果组件立即销毁(unmount)的话，而当前请求还没发完，岂不是造成了在一个 unmount组件里面setState了么？ 是的，确实如此，当前我就在想了，为何在redux(dva)管理下，我们进行 dispatch一个action, 这里有可能进行异步操作, 操作完成后，redux更新执行reducers，更新state，再更新组件，为何不会报错？因为异步的时候，我有可能直接销毁了这个组件，但是后面redux有调用了它的setState，岂不是应该报错？，于是我对此进行了探考。

当然 这里就不分析redux代码了，没看过的先去看一遍redux的代码
先看看react-redux的源代码结构
```
│  index.js
│
├─components
│      connectAdvanced.js   //最关键的
│      Provider.js     //作用为传递上下文中的store
│
├─connect
│      connect.js  //其实只是对connectAdvanced套一层而已
│      mapDispatchToProps.js
│      mapStateToProps.js
│      mergeProps.js  //将多个对象进行合并
│      selectorFactory.js  //这个也非常关键 selector作用为得到connnect组件属性
│      verifySubselectors.js
│      wrapMapToProps.js
│
└─utils
        PropTypes.js
        shallowEqual.js
        Subscription.js //非常重要
        verifyPlainObject.js
        warning.js
        wrapActionCreators.js
```
上面我标记的那几个文件是对于理解来说最关键的文件，其他的文件自己看看即可

我们知道，一个Provider下面 管理者许多 Connect组件, 其实一个Connect组件下面，还可以有其他Connect组件，react-redux有处理了这一点

源码里有个非常重要的概念是 selector，这个selector的作用是对 Connect组件的props进行merge，然后判断前后是否一致，是的话，Connect组件就不更新，不是的话，组件就更新

在selectorFactory.js里面，有两个创建selector的工厂，```pureFinalPropsSelectorFactory``` 和 ```impureFinalPropsSelectorFactory```, 这个
```impureFinalPropsSelectorFactory```做法比较暴力，每次都会生成一个新的属性对象
```javascript
 // selectr的创建函数
  return function impureFinalPropsSelector(state, ownProps) {
    return mergeProps(
      mapStateToProps(state, ownProps),
      mapDispatchToProps(dispatch, ownProps),
      ownProps
    )
  }
```
mergeProps 只是把上面的三个对象和并成一个对象，然后得到Connnect组件的属性值，然后进行注入。 而 ```pureFinalPropsSelectorFactory```呢？ 它会缓存上一次生成的 属性值，然后每当要创建新的selector的时候，它会新进行判断 state是否更新，ownProps是否进行更新，如果都不进行更新的话，直接返回上一次缓存的值，这里注意一下，其实在Connect组件里面已经帮我们做了一层优化，
```javascript
        if (nextProps !== selector.props || selector.error) {
          //设置更新的标志
          selector.shouldComponentUpdate = true
          selector.props = nextProps
          selector.error = null
        }
```
如果前后的对象不是同一个对象的话， 那么selector.shouldComponentUpdate = true，即更新，如果是同一个的话，就不更新了，它是根据Connect组件的 merge后的属性得的结论来的。但是默认的情况下，使用的是impureFinalPropsSelectorFactory 
```javascript
  const selectorFactory = options.pure
    ? pureFinalPropsSelectorFactory
    : impureFinalPropsSelectorFactory //默认使用
```
如果你想要那个缓存结果的话，不妨考虑一下，如何在这里进行优化。
所以使用默认的 impureFinalPropsSelectorFactory , 这个nextProps !== selector.props判断就无效了。

在selector有个run, 作用就是计算出 Connect前后的props，然后进行比较判断是否进行更新。

**下面就是最重点的了**
react-redux如何和redux联系在一起，即redux在dispatch的时候，是如何通知react进行更新的？
我们知道，redux实际也是一个事件的订阅机制，它和react联系主要在Connect组件，它会订阅Connect组件里面的onStateChange函数，当redux进行dispatch的时候，就会触发Connect组件的onStateChange函数，那么就会触发组件的setState从而进行更新
我们看看 Connect组件的 onStateChange定义

```javascript
      onStateChange() {
        this.selector.run(this.props) 
        if (!this.selector.shouldComponentUpdate) {
          this.notifyNestedSubs()
        } else {
          this.componentDidUpdate = this.notifyNestedSubsOnComponentDidUpdate
          this.setState(dummyState)
        }
      }
```
这个this.selector.run(this.props) 是干啥的？前面有提到过, 重新计算当前Connect组件的props，然后和前一次进行比较，如果不是同一个对象的话，就设置
this.selector.shouldComponentUpdate = true, 即更新当前组件
如果是同一个对象话，自然 this.selector.shouldComponentUpdate = false;
接着往下看
如果当前Connect不更改下，立即执行this.notifyNestedSubs()
这个是啥意思？是这样的，每个Connect组件里面都有一个subscription对象，它也是一个订阅模型，每个父的Connect订阅的是 子Connect组件的onStateChange函数，而父的Connect的onStateChange函数，被谁订阅呢？当然是store(redux)啦， 即流程为
dispathc(action）---触发store的订阅即父的onStateChange---父的onStateChange触发即触发子Connect的onStateChange，这样就能层层更新了。

我们看看 他们是在哪了完成订阅的 每个Connect组件里面有个

```javascript
      initSubscription() {
        if (!shouldHandleStateChanges) return
        //父Sub从哪里过来
        const parentSub = (this.propsMode ? this.props : this.context)[subscriptionKey]

        //在Connect组件里面新建一个Subscription
        this.subscription = new Subscription(this.store, parentSub, this.onStateChange.bind(this))

        this.notifyNestedSubs = this.subscription.notifyNestedSubs.bind(this.subscription)
      }
```
initSubscription里面完成订阅，会在 construct里面调用。 什么时候会挂载带会把onStateChange挂载到store订阅里面，直接看 Subscription.js里面的trySubscriptiion定义

```javascript
  trySubscribe() {
    if (!this.unsubscribe) {
      this.unsubscribe = this.parentSub
        ? this.parentSub.addNestedSub(this.onStateChange)
        : this.store.subscribe(this.onStateChange) //没有父sub，就把组件的 
       //  onStateChange加入到 redux的store中
      this.listeners = createListenerCollection()
    }
  }
```

最后, 当组件unmount后, 如何让dispathc的时候，不更新(即不用setState)？
```javascript
      componentWillUnmount() {

        //容器组件卸载后，取消当前的订阅
        if (this.subscription) this.subscription.tryUnsubscribe() //取消下面子Connect的更新
        this.subscription = null
        this.notifyNestedSubs = noop
        this.store = null
        this.selector.run = noop
        //设置为不可以更新---！！！这个也是为什么，redux管理下的Connect容器组件 调用异步
        //异步里面有setState，然后理解退出，这个时候异步还没完成，但是组件已经unmount了，
        //而组件并没有发生 在unmount组件上面使用setState错误的原因 ！！！
        this.selector.shouldComponentUpdate = false
      }
```