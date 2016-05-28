/**
 * Created by BronzeBee on 28.05.2016.
 */

var async = require('async');

const AUTH_KEY = 'authKey';

const MAX_RETRIES = 3;

function SocketHandler(port) {
    this.app = require('http').createServer().listen(port);
    this.io = require('socket.io')(this.app);
    this.clients = {};
    this.adminClients = [];
    this.ipCooldown = {};
    this.authorizedClients = {};
}

SocketHandler.prototype.setUpListeners = function () {
    var self = this;

    self.io.on('connection', function (socket) {
        if (socket.handshake.query.authToken === AUTH_KEY) {

            socket.emit('authSuccess');
            self.adminClients.push(socket);

            socket.on('disconnect', function() {
                delete self.adminClients[self.adminClients.indexOf(socket)];
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
                if (self.clients[socket.handshake.address].length === 0)
                    delete self.clients[socket.handshake.address];
            }

            self.io.emit('online', Object.keys(self.clients).length);

            socket.once('disconnect', function () {
                delete self.clients[socket.handshake.address][self.clients[socket.handshake.address].indexOf(socket)];
                if (self.clients[socket.handshake.address].length === 0) {
                    delete self.clients[socket.handshake.address];
                    if (self.authorizedClients[socket.handshake.address])
                        delete self.authorizedClients[socket.handshake.address];
                }
                self.io.emit('online', Object.keys(self.clients).length);
            });

            socket.on('steamAuth', function (steamID) {
                self.authorizedClients[socket.handshake.address] = {client: socket, steamID: steamID};
            });
        }

    });
}

SocketHandler.prototype.addEventListener = function (event, listener) {
    self.io.on(event, listener);
}

SocketHandler.prototype.addAdminEventListener = function (event, listener) {
    var self = this;
    async.forEachOfSeries(self.adminClients, function (socket, key, callback) {
        socket.on(event, listener);
    }, function () {
        return;
    });
}

SocketHandler.prototype.send = function (event, param) {
    self.io.emit(event, param);
}

SocketHandler.prototype.sendToUser = function (steamID, event, param) {
    var self = this;
    async.forEachOfSeries(self.authorizedClients, function(client, index, callback) {
        if (client.steamID === steamID) {
            client.client.emit(event, param);
        } else
            callback();
    }, function() {
        return;
    });
}

SocketHandler.prototype.sendToAdmins = function (event, param) {
    var self = this;
    async.forEachOfSeries(self.adminClients, function (socket, key, callback) {
        socket.emit(event, param);
    }, function () {
        return;
    });
}

module.exports = SocketHandler;