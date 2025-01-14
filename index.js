var _ = require("underscore")
var Net = require("net")
var Tls = require("tls")
var Http = require("http")
var ClientRequest = Http.ClientRequest
var Socket = require("./lib/socket")
var TlsSocket = require("./lib/tls_socket")
var EventEmitter = require("events").EventEmitter
var InternalSocket = require("./lib/internal_socket")
var Stubs = require("./lib/stubs")
var slice = Function.call.bind(Array.prototype.slice)
var normalizeConnectArgs = Net._normalizeConnectArgs || Net._normalizeArgs
var createRequestAndResponse = Http._connectionListener
module.exports = Mitm

function Mitm() {
  if (!(this instanceof Mitm))
    return Mitm.apply(Object.create(Mitm.prototype), arguments).enable()

  this.stubs = new Stubs()
  this.on("request", addCrossReferences)

  return this
}

Mitm.prototype.on = EventEmitter.prototype.on
Mitm.prototype.once = EventEmitter.prototype.once
Mitm.prototype.off = EventEmitter.prototype.removeListener
Mitm.prototype.addListener = EventEmitter.prototype.addListener
Mitm.prototype.removeListener = EventEmitter.prototype.removeListener
Mitm.prototype.emit = EventEmitter.prototype.emit

var IncomingMessage = Http.IncomingMessage
var ServerResponse = Http.ServerResponse
var incomingMessageKey = require("_http_common").kIncomingMessage
var serverResponseKey = require("_http_server").kServerResponse
Mitm.prototype[serverResponseKey] = ServerResponse
Mitm.prototype[incomingMessageKey] = IncomingMessage

Mitm.prototype.enable = function () {
  // Connect is called synchronously.
  var netConnect = this.tcpConnect.bind(this, Net.connect)
  var tlsConnect = this.tlsConnect.bind(this, Tls.connect)

  this.stubs.stub(Net, "connect", netConnect)
  this.stubs.stub(Net, "createConnection", netConnect)
  this.stubs.stub(Http.Agent.prototype, "createConnection", netConnect)
  this.stubs.stub(Tls, "connect", tlsConnect)

  // ClientRequest.prototype.onSocket is called synchronously from
  // ClientRequest's constructor and is a convenient place to hook into new
  // ClientRequests.
  // this.stubs.stub(
  //   ClientRequest.prototype,
  //   "onSocket",
  //   [ClientRequest.prototype.onSocket, this.request.bind(this)].reduce(comp, id)
  // );
  this.stubs.stub(
    ClientRequest.prototype,
    "onSocket",
    _.compose(ClientRequest.prototype.onSocket, this.request.bind(this))
  )

  return this
}

Mitm.prototype.disable = function () {
  return this.stubs.restore(), this
}

Mitm.prototype.connect = function connect(orig, Socket, opts, done) {
  var sockets = InternalSocket.pair()

  // Don't set client.connecting to false because there's nothing setting it
  // back to false later. Originally that was done in Socket.prototype.connect
  // and its afterConnect handler, but we're not calling that.
  var client = new Socket({
    ...{
      handle: sockets[0],

      // Node v10 expects readable and writable to be set at Socket creation time.
      readable: true,
      writable: true,
    },
    ...opts,
  })

  this.emit("connect", client, opts)
  if (client.delay) {
    const origSocket = orig.call(this, opts, done)
    origSocket.pause()
    setTimeout(() => {
      origSocket.resume()
    }, client.delay)
    return origSocket
  }
  if (client.bypassed) return orig.call(this, opts, done)

  // Don't use just "server" because socket.server is used in Node v8.12 and
  // Node v9.6 and later for modifying the HTTP server response and parser
  // classes. If unset, it's set to the used HTTP server (Mitm instance in our
  // case) in _http_server.js.
  // See also: https://github.com/nodejs/node/issues/13435.
  var server = (client.serverSocket = new Socket({
    handle: sockets[1],
    readable: true,
    writable: true,
  }))

  this.emit("connection", server, opts)

  // Ensure connect is emitted in next ticks, otherwise it would be impossible
  // to listen to it after calling Net.connect or listening to it after the
  // ClientRequest emits "socket".
  setTimeout(client.emit.bind(client, "connect"))
  setTimeout(server.emit.bind(server, "connect"))

  return client
}

Mitm.prototype.tcpConnect = function (orig, opts, done) {
  var args = normalizeConnectArgs(slice(arguments, 1))
  opts = args[0]
  done = args[1]

  // The callback is originally bound to the connect event in
  // Socket.prototype.connect.
  var client = this.connect(orig, Socket, opts, done)
  if (client.serverSocket == null) return client
  if (done) client.once("connect", done)

  return client
}

Mitm.prototype.tlsConnect = function (orig, opts, done) {
  var args = normalizeConnectArgs(slice(arguments, 1))
  opts = args[0]
  done = args[1]

  var client = this.connect(orig, TlsSocket, opts, done)
  if (client.serverSocket == null) return client
  if (done) client.once("secureConnect", done)

  setTimeout(client.emit.bind(client, "secureConnect"))

  return client
}

Mitm.prototype.request = function request(socket) {
  if (!socket.serverSocket) return socket

  // Node >= v0.10.24 < v0.11 will crash with: «Assertion failed:
  // (!current_buffer), function Execute, file ../src/node_http_parser.cc, line
  // 387.» if ServerResponse.prototype.write is called from within the
  // "request" event handler. Call it in the next tick to work around that.
  var self = this

  createRequestAndResponse.call(self, socket.serverSocket)
  return socket
}

function addCrossReferences(req, res) {
  req.res = res
  res.req = req
}
