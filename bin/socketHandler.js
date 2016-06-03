/**
 * Created by BronzeBee on 28.05.2016.
 */

var async = require('async');

const AUTH_KEY = 'bd2e932a03a19217ab5a1dfb5aa93340';

function SocketHandler(port) {
    this.app = require('http').createServer().listen(port);
    this.io = require('socket.io')(this.app);
    this.clients = {};
    this.adminClients = [];
    this.ipCooldown = {};
    this.clientsBySteamID = {};
    this.steamIDByClients = {};
    this.adminListeners = [];
}

SocketHandler.prototype.hasValue = function (object, value) {
    for (var key in object) {
        if (object[key] === value)
            return true;
    }
    return false;
}

SocketHandler.prototype.setUpListeners = function () {
    var self = this;

    self.io.on('connection', function (socket) {
        if (socket.handshake.query.authToken === AUTH_KEY) {

            socket.emit('authSuccess');
            self.adminClients.push(socket);

            socket.on('disconnect', function () {
                self.adminClients.splice(self.adminClients.indexOf(socket), 1);
            });

            socket.on('_ping', function () {
                socket.emit('_pong');
            });

            self.adminListeners.forEach(function (el) {
                socket.on(el.event, function () {
                    var mainArguments = Array.prototype.slice.call(arguments);
                    mainArguments.unshift(socket);
                    el.listener.apply(this, mainArguments);
                });
            });

        } else {
            if (!self.clients[socket.handshake.address]) {
                self.clients[socket.handshake.address] = [socket];
            } else {
                self.clients[socket.handshake.address].push(socket);
                if (self.clients[socket.handshake.address].length >= 5) {
                    socket.disconnect();
                }
                delete self.clients[socket.handshake.address][self.clients[socket.handshake.address].indexOf(socket)];
                if (self.clients[socket.handshake.address].length === 0) {
                    delete self.clients[socket.handshake.address];
                }

            }

            self.io.emit('online', Object.keys(self.clients).length);

            socket.once('disconnect', function () {
                delete self.clients[socket.handshake.address][self.clients[socket.handshake.address].indexOf(socket)];
                if (self.clients[socket.handshake.address].length === 0) {
                    delete self.clients[socket.handshake.address];
                    if (self.steamIDByClients[socket.handshake.address]) {
                        var steamID = self.steamIDByClients[socket.handshake.address];
                        delete self.clientsBySteamID[steamID][self.steamIDByClients[steamID].indexOf(socket)];
                        delete self.steamIDByClients[socket.handshake.address];
                    }

                }
                self.io.emit('online', Object.keys(self.clients).length);
            });

            socket.on('steamAuth', function (steamID) {
                if (!self.clientsBySteamID[steamID]) {
                    self.clientsBySteamID[steamID] = [socket];

                } else {
                    self.clientsBySteamID[steamID].push(socket);
                }
                self.steamIDByClients[socket.handshake.address] = steamID;
            });
        }

    });
}

SocketHandler.prototype.addEventListener = function (event, listener) {
    self.io.on(event, listener);
}

SocketHandler.prototype.addAdminEventListener = function (event, listener) {
    var self = this;
    self.adminListeners.push({event: event, listener: listener});
    async.forEachOfSeries(self.adminClients, function (socket, key, callback) {
        socket.on(event, function () {
            var mainArguments = Array.prototype.slice.call(arguments);
            mainArguments.unshift(socket);
            listener.apply(this, mainArguments);
        });
        callback();
    }, function () {
        return;
    });
}

SocketHandler.prototype.send = function () {
    var self = this;
    self.io.emit.apply(self.io, arguments);
}

SocketHandler.prototype.sendToUser = function () {
    var self = this;
    var args = arguments;
    var newArgs = args.slice(1, args.length);
    self.clientsBySteamID[args[0]].forEach(function (socket) {
        socket.emit(newArgs);
    });
}

SocketHandler.prototype.sendToAdmins = function () {
    var self = this;
    var args = arguments;
    async.forEachOfSeries(self.adminClients, function (socket, key, callback) {
        socket.emit.apply(socket, args);
        callback();
    }, function () {
        return;
    });
}

module.exports = SocketHandler;