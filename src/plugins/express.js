'use strict'

const opentracing = require('opentracing')
const Tags = opentracing.Tags
const FORMAT_HTTP_HEADERS = opentracing.FORMAT_HTTP_HEADERS
const METHODS = require('methods').concat('use', 'route', 'param', 'all')
const pathToRegExp = require('path-to-regexp')

const OPERATION_NAME = 'express.request'

function createWrapMethod (tracer, config) {
  const validateStatus = typeof config.validateStatus === 'function'
    ? config.validateStatus
    : code => code < 500

  function middleware (req, res, next) {
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
    const childOf = tracer.extract(FORMAT_HTTP_HEADERS, req.headers)

    const span = tracer.startSpan(OPERATION_NAME, {
      childOf,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_SERVER,
        [Tags.HTTP_URL]: url,
        [Tags.HTTP_METHOD]: req.method
      }
    })

    const originalEnd = res.end

    res.end = function () {
      const returned = originalEnd.apply(this, arguments)
      const path = req._datadog_paths.join('')
      const resource = [req.method].concat(path).filter(val => val).join(' ')

      span.setTag('resource.name', resource)
      span.setTag('service.name', config.service || tracer._service)
      span.setTag('span.type', 'http')
      span.setTag(Tags.HTTP_STATUS_CODE, res.statusCode)

      if (!validateStatus(res.statusCode)) {
        span.setTag(Tags.ERROR, true)
      }

      span.finish()

      return returned
    }

    Object.defineProperties(req, {
      _datadog_trace_patched: { value: true },
      _datadog_span: { value: span },
      _datadog_paths: { value: [] }
    })

    next()
  }

  return function wrapMethod (original) {
    return function methodWithTrace () {
      if (!this._datadog_trace_patched && !this._router) {
        this._datadog_trace_patched = true
        this.use(middleware)
      }
      return original.apply(this, arguments)
    }
  }
}

function createWrapProcessParams (tracer, config) {
  return function wrapProcessParams (processParams) {
    return function processParamsWithTrace (layer, called, req, res, done) {
      const matchers = layer._datadog_matchers

      if (matchers) {
        // Try to guess which path actually matched
        for (let i = 0; i < matchers.length; i++) {
          if (matchers[i].test(layer.path)) {
            req._datadog_paths.push(matchers[i].path)

            break
          }
        }
      }

      return processParams.apply(this, arguments)
    }
  }
}

function createWrapRouterMethod (tracer) {
  return function wrapRouterMethod (original) {
    return function methodWithTrace (fn) {
      const offset = this.stack.length
      const router = original.apply(this, arguments)
      const matchers = extractMatchers(fn)

      this.stack.slice(offset).forEach(layer => {
        const handleRequest = layer.handle_request
        const handleError = layer.handle_error

        layer.handle_request = (req, res, next) => {
          return handleRequest.call(layer, req, res, wrapNext(tracer, layer, req, next))
        }

        layer.handle_error = (error, req, res, next) => {
          return handleError.call(layer, error, req, res, wrapNext(tracer, layer, req, next))
        }

        layer._datadog_matchers = matchers
      })

      return router
    }
  }
}

function wrapNext (tracer, layer, req, next) {
  if (req._datadog_trace_patched) {
    const scope = tracer.scopeManager().activate(req._datadog_span)
    const originalNext = next

    return function () {
      if (layer.path && !layer.regexp.fast_star) {
        req._datadog_paths.pop()
      }

      scope.close()

      originalNext.apply(null, arguments)
    }
  }

  return next
}

function extractMatchers (fn) {
  const arg = flatten([].concat(fn))

  if (typeof arg[0] === 'function') {
    return []
  }

  return arg.map(pattern => ({
    path: pattern instanceof RegExp ? `(${pattern})` : pattern,
    test: path => pathToRegExp(pattern).test(path)
  }))
}

function flatten (arr) {
  return arr.reduce((acc, val) => Array.isArray(val) ? acc.concat(flatten(val)) : acc.concat(val), [])
}

function patch (express, tracer, config) {
  METHODS.forEach(method => {
    this.wrap(express.application, method, createWrapMethod(tracer, config))
  })
  this.wrap(express.Router, 'process_params', createWrapProcessParams(tracer, config))
  this.wrap(express.Router, 'use', createWrapRouterMethod(tracer, config))
  this.wrap(express.Router, 'route', createWrapRouterMethod(tracer, config))
}

function unpatch (express) {
  METHODS.forEach(method => this.unwrap(express.application, method))
  this.unwrap(express.Router, 'process_params')
  this.unwrap(express.Router, 'use')
  this.unwrap(express.Router, 'route')
}

module.exports = {
  name: 'express',
  versions: ['4.x'],
  patch,
  unpatch
}
