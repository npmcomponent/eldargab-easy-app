var parseFnArgs = require('parse-fn-args')

module.exports = Container

function Container () {
  if (!(this instanceof Container)) {
    return new Container
  }
}

function ThisObj (name) {
  return function thisObj () {
    if (this[name].__owner === this) return this[name]
    this[name] = Object.create(thisObj.call(this.__proto__))
    setOwner(this, name)
    return this[name]
  }
}

function setOwner (obj, prop) {
  Object.defineProperty(obj[prop], '__owner', {
    value: obj
  })
}

Container.prototype.values = {}
setOwner(Container.prototype, 'values')
Container.prototype.thisValues = ThisObj('values')

Container.prototype.tasks = {}
setOwner(Container.prototype, 'tasks')
Container.prototype.thisTasks = ThisObj('tasks')

Container.prototype.aliases = {}
setOwner(Container.prototype, 'aliases')
Container.prototype.thisAliases = ThisObj('aliases')

Container.prototype.set = function (name, val) {
  this.thisValues()[name] = val
  return this
}

Container.prototype.get = function (name) {
  var val = this.values[name]
  if (val !== undefined) return val
  if (this.aliases[name]) return this.get(this.aliases[name])
}

Container.prototype.alias = function (from, to) {
  this.thisAliases()[from] = to
  return this
}

Container.prototype.def = function (layer, task, deps, fn) {
  if (typeof task != 'string') { // allow layer omission
    fn = deps
    deps = task
    task = layer
    layer = null
  }

  if (typeof deps == 'function') { // allow implicit deps
    fn = deps
    deps = fn.deps || parseFnArgs(fn)
  }

  this.thisTasks()[task] = {
    fn: fn,
    deps: deps,
    layer: layer
  }
  return this
}

Container.prototype.install = function (namespace, app, aliases) {
  if (typeof namespace != 'string') {
    aliases = app
    app = namespace
    namespace = ''
  } else {
    namespace += '.'
  }
  function mix (target, src, cb) {
    cb = cb || function (val) { return val }
    for (var key in src) {
      target[namespace + key] = cb(src[key], key)
    }
  }
  mix(this.thisValues(), app.values)

  mix(this.thisTasks(), app.tasks, function (t) {
    return {
      fn: t.fn,
      layer: t.layer,
      deps: t.deps.map(function (dep) {
        return dep == 'done'
          ? dep
          : namespace + dep
      })
    }
  })

  mix(this.thisAliases(), app.aliases, function (alias) {
    return namespace + alias
  })

  for (var key in aliases) {
    this.alias(namespace + key, aliases[key])
  }

  return this
}

Container.prototype.layer = function (name) {
  this.name = name
  return this
}

Container.prototype.run = function () {
  return Object.create(this)
}

Container.prototype.eval = function (task, cb) {
  var val = this.values[task]

  if (val !== undefined) {
    if (cb) val instanceof Error
      ? cb.call(this, val)
      : cb.call(this, null, val)
    return
  }

  if (this.aliases[task]) {
    this.eval(this.aliases[task], function (err, val) {
      this.set(task, err || val)
      cb.call(this, err, val)
    })
    return
  }

  var ev = '_eval_' + task
  if (!this[ev]) {
    var t = this.tasks[task]
    if (!t) return cb && cb(new Error('Task ' + task + ' is not defined'))
    new Evaluation(this, cb)
      .task(task, t)
      .start()
  } else {
    cb && this[ev].ondone(cb)
  }
}


function Evaluation (container, cb) {
  this.c = container
  this.callbacks = []
  this.deps = []
  cb && this.ondone(cb)
}

Evaluation.prototype.ondone = function (cb) {
  this.callbacks.push(cb)
}

Evaluation.prototype.task = function (name, def) {
  this.t = def
  this.name = name
  this.setApp()
  this.app['_eval_' + this.name] = this
  return this
}

Evaluation.prototype.setApp = function () {
  if (!this.t.layer) return this.app = this.c
  var app = this.c
  while (app.name && (app.name != this.t.layer || !app.hasOwnProperty('name'))) {
    app = app.__proto__
  }
  this.app = app.name == this.t.layer ? app : this.c
}


Evaluation.prototype.start = function () {
  this.evalDeps(0)
}


Evaluation.prototype.evalDeps = function (index) {
  var sync = true
    , deps = this.t.deps
    , val

  while (sync) {
    var dep = deps[index]
    if (!dep) return this.exec()

    if (dep == 'done') {
      this.async = true
      this.deps[index++] = this.done.bind(this)
      continue
    }

    val = this.app.values[dep]
    if (val !== undefined) {
      if (val instanceof Error) return this.done(val)
      this.deps[index++] = val
      continue
    }

    var done = false

    this.app.eval(dep, function (err, val) {
      if (err) return this.done(err)
      done = true
      this.deps[index++] = val
      if (sync) return
      this.evalDeps(index)
    }.bind(this))

    sync = done
  }
}

Evaluation.prototype.exec = function () {
  try {
    if (this.async) {
      this.t.fn.apply(null, this.deps)
    } else {
      this.done(null, this.t.fn.apply(null, this.deps))
    }
  } catch (e) {
    this.done(e)
  }
}

Evaluation.prototype.done = function (err, val) {
  if (this.ended) {
    console.error(
      this.name
        ? 'Task <' + this.name + '> called its callback twice'
        : 'Some evaluation called its callback twice'
    )
    if (err) {
      console.error('It seems that it happened because of exception in the task callback:')
      err.stack ? console.error(err.stack) : console.error(String(err))
    }
    return
  }
  this.ended = true

  if (err != null) {
    if (!(err instanceof Error)) {
      err = new Error(String(err))
    }
    err.task = err.task || this.name
    val = err
  } else {
    val = val === undefined ? null : val
  }

  this.app.set(this.name, val)
  delete this.app['_eval_' + this.name] // cleanup

  for (var i = 0; i < this.callbacks.length; i++) {
    this.callbacks[i].call(this.c, err, val)
  }
}

