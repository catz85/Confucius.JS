/**
 * Created by BronzeBee on 20.05.2016.
 */

var async = require('async');
var crypto = require('crypto');
var events = require('events');
var util = require('util');

util.inherits(Game, events.EventEmitter);

const State = {
    WAITING: 0,
    ACTIVE: 1,
    ROLLING: 2,
    SENT: 3,
    PAUSED: 4
}

const RETRY_INTERVAL = 3000;
const MAX_RETRIES = 5;

function Game(id, db, marketHelper, steamHelper, info, logger) {
    this.id = id;
    this.info = info;
    this.db = db;
    this.marketHelper = marketHelper;
    this.steamHelper = steamHelper;
    this.gameTimer = info.gameDuration;
    this.currentBank = 0;
    this.bets = [];
    this.float = Math.random();
    this.hash = crypto.createHash('md5').update(this.float + '').digest('hex');
    this.timerID = -1;
    this.state = State.WAITING;
    this.betsByPlayer = {};
    this.winner = null;
    this.pauseTimer = -1;
    this.logger = logger ? logger : {
        error: function (msg) {
            console.log(msg);
        }, info: function (msg) {
            console.log(msg);
        }
    }
}

Game.State = State;

Game.createFromDB = function (data, callback, numRetries) {
    data.db.collection('games').find({id: data.id}).toArray(function (err, items) {
        if (err) {
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES)
                Game.createFromDB(data, callback, numRetries);
            else
                throw new Error('Не удалось получить информацию из б/д');
        } else {
            if (items.length > 0) {
                var gameData = items[0];
                var game = new Game(data.id, data.db, data.marketHelper, data.steamHelper, data.info, data.logger);
                if (!data.infoOnly) {
                    game.resume({
                        startTime: gameData.startTime,
                        finishTime: gameData.finishTime,
                        bank: gameData.bank,
                        bets: gameData.bets,
                        winner: gameData.winner,
                        float: gameData.float,
                        hash: gameData.hash,
                        state: gameData.state,
                        pauseTimer: data.pauseTimer
                    });
                }
                callback(game);
            } else {
                callback(null);
            }
        }
    });
}

Game.prototype.addBet = function (better, items, totalCost, callback, numRetries) {
    var self = this;
    var itemsArray = [];
    var costFrom = self.currentBank + 1;
    var costTo = self.currentBank + totalCost;
    async.forEachOfSeries(items, function (item, key, cb) {
        var newItem = {
            id: item.id,
            name: item.name,
            market_hash_name: item.market_hash_name,
            cost: (item.cost / 100).toFixed(2),
            image: item.getImageURL(),
        };
        itemsArray.push(newItem);
        cb();
    }, function () {
        self.currentBank += totalCost;
        var bet = {
            steamID: better.steamID.getSteamID64(),
            nickname: better.name,
            deposit: totalCost,
            avatar: better.getAvatarURL(),
            items: itemsArray,
            costFrom: costFrom,
            costTo: costTo
        };
        self.db.collection('games').updateOne({id: self.id}, {$push: {bets: bet}}, {w: 1}, function (err, result) {
            if (err) {
                self.logger.error('Ошибка при внесении ставки в базу данных');
                self.logger.error(err.stack || err);
                if (numRetries)
                    numRetries = 1;
                else
                    numRetries++;
                if (numRetries < MAX_RETRIES)
                    setTimeout(function () {
                        self.addBet(better, items, totalCost, callback, numRetries);
                    }, RETRY_INTERVAL / 3);
                else
                    self.emit('fatalError');
            } else {
                self.bets.push(bet);
                callback();
            }
        });
    });
}

Game.prototype.sortBetsByPlayer = function (callback) {
    var self = this;
    var sortedItems = {};
    self.getAllItems(function (gameItems) {
        async.forEachOfSeries(gameItems, function (item, index, cb) {
            if (sortedItems[item.owner]) {
                var data = self.marketHelper.getItemData(item.market_hash_name);
                sortedItems[item.owner].totalCost += data.value;
                sortedItems[item.owner].count++;
            } else {
                sortedItems[item.owner] = {totalCost: 0, count: 0, chance: 0};
                var data = self.marketHelper.getItemData(item.market_hash_name);
                sortedItems[item.owner].totalCost += data.value;
                sortedItems[item.owner].count++;
            }
            cb();
        }, function () {
            self.betsByPlayer = sortedItems;
            self.recalculateChance(function () {
                if (callback)
                    callback();
            });
        });
    });
}

Game.prototype.recalculateChance = function (callback) {
    var self = this;
    async.forEachOfSeries(self.betsByPlayer, function (data, key, cb) {
        self.betsByPlayer[key].chance = (data.totalCost / self.currentBank * 100).toFixed(2);
        cb();
    }, function () {
        if (callback)
            callback();
    });
}

Game.prototype.setState = function (newState, callback, numRetries) {
    var self = this;
    if (self.state !== newState) {
        self.db.collection('games').updateOne({id: self.id}, {$set: {state: newState}}, {w: 1}, function (err, result) {
            if (err) {
                if (!numRetries)
                    numRetries = 1;
                else
                    numRetries++;
                self.logger.error('Не удалось обновить статус игры #' + self.id);
                self.logger.error(err.stack || err);
                if (numRetries < MAX_RETRIES) {
                    self.logger.error('Пытаюсь снова');
                    setTimeout(function () {
                        self.setState(newState, callback, numRetries);
                    }, RETRY_INTERVAL / 2);
                } else {
                    self.emit('fatalError');
                }
            } else {
                self.emit('notification', 'Статус игры #' + self.id + ' изменен с ' + Object.keys(State)[self.state] +
                    ' на ' + Object.keys(State)[newState]);
                self.state = newState;
                if (callback)
                    callback();
            }
        });
    } else {
        if (callback)
            callback();
    }
}

Game.prototype.selectWinner = function (callback) {
    var self = this;
    if (self.winner) {
        callback(self.winner);
    } else {
        var winnerNumber = Math.max((self.currentBank * self.float).toFixed(0) * 1, 1);
        async.forEachOfSeries(self.bets, function (bet, key, cb) {
            if (winnerNumber >= Number(bet.costFrom) && winnerNumber <= Number(bet.costTo)) {
                callback(bet.steamID);
            } else {
                cb();
            }
        }, function () {
            callback(null);
        });
    }
}


Game.prototype.pause = function (callback) {
    var self = this;
    if (!callback)
        callback = function () {
            return;
        }
    if (self.state === State.ROLLING)
        callback(new Error('Запущена рулетка'));
    else if (self.state === State.PAUSED) {
        callback(new Error('Игра уже приостановлена'));
    } else {
        var time = self.gameTimer;
        clearInterval(self.timerID);
        self.db.collection('info').updateOne({name: 'pauseTimer'}, {$set: {value: time}}, {w: 1}, function (err, result) {
            if (err) {
                self.logger.error(err.stack || err);
                self.startTimer();
            } else {
                self.pauseTimer = time;
                self.setState(State.PAUSED, function () {
                    callback(null);
                });
            }
        });
    }
};

Game.prototype.unpause = function (callback) {
    if (!callback)
        callback = function () {
            return;
        }
    var self = this;
    if (self.state === State.PAUSED) {
        self.db.collection('info').updateOne({name: 'pauseTimer'}, {$set: {value: -1}}, {w: 1}, function (err, result) {
            if (err) {
                self.logger.error(err.stack || err);
                callback(err);
            } else {
                var timer = self.pauseTimer;
                self.pauseTimer = -1;
                self.gameTimer = timer;
                self.update(function () {
                    callback(null);
                }, timer);
            }
        });
    } else {
        callback(new Error('Игра не приостановлена'));
    }
}

Game.prototype.saveFinishTime = function (time, callback, numRetries) {
    var self = this;
    var id = self.id;
    self.db.collection('games').updateOne({id: id}, {$set: {finishTime: time}}, {w: 1}, function (error, result) {
        if (error) {
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            self.logger.error(error.stack || error);
            if (numRetries < MAX_RETRIES) {
                setTimeout(function () {
                    self.saveFinishTime(time, id, callback, numRetries);
                }, RETRY_INTERVAL / 2);
            }
        } else {
            callback();
        }
    });
}

Game.prototype.roll = function (callback) {
    var self = this;
    self.setState(State.ROLLING, function () {
        self.selectWinner(function (winnerID) {
            var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper, self.info,
                self.logger);
            self.emit('newGame', newGame);
            self.steamHelper.getSteamUser(winnerID, function (winner) {
                self.emit('notification', 'Игра #' + self.id + ' завершена, победитель: ' + winner.name);
                self.emit('roll', winner);
                var rollTime = Date.now();
                self.saveFinishTime(function () {
                    self.sortWonItems(winner, function (wonItems) {
                        self.getUserToken(winnerID, function (token) {
                            var timeout = self.info.spinDuration * 1000 - (Date.now() - rollTime);
                            setTimeout(function () {
                                self.emit('rollFinished');
                                self.sendWonItems(wonItems, winner, token, function () {
                                    self.submit(winner, (self.betsByPlayer[data.winner].totalCost /
                                    self.currentBank).toFixed(2), function () {
                                        self.setState(State.SENT);
                                    })
                                });
                            }, timeout > 0 ? timeout : 0);
                        });

                    });
                });
            });
        });
    });
}

Game.prototype.getAllItems = function (callback) {
    var self = this;
    var items = [];
    async.forEachOfSeries(self.bets, function (bet, key, cbf) {
        var owner = bet.steamID;
        async.forEachOfSeries(bet.items, function (item, key0, cb) {
            item.owner = owner;
            items.push(item);
            cb();
        }, function () {
            cbf();
        });
    }, function () {
        callback(items);
    });
}

Game.prototype.getUserToken = function (steamID, callback, numRetries) {
    var self = this;
    self.db.collection('users').find({steamID: steamID}).toArray(function (err, users) {
        if (err) {
            self.logger.error(err.stack || err);
            if (!numRetries)
                numRetries = 1;
            else
                numRetries++;
            if (numRetries < MAX_RETRIES)
                setTimeout(function () {
                    self.getToken(steamID, callback, numRetries);
                }, RETRY_INTERVAL / 2);
            else
                self.emit('fatalError');
        } else {
            if (!users) {
                callback(null);
            } else if (!users[0].token) {
                callback(null);
            } else {
                callback(users[0].token);
            }
        }
    });
}

Game.prototype.sortWonItems = function (user, callback) {
    var self = this;
    self.steamHelper.loadMyInventory(self.info.appID, function (items) {
        var itemsToSend = [];
        self.getAllItems(function (gameItems) {
            self.emit('calcFee', user, function (multiplier) {
                var feeSize = self.currentBank * multiplier;
                var totalFee = feeSize;
                var feeItems = 0;
                gameItems.sort(function (a, b) {
                    return (a.cost > b.cost) ? 1 : ((b.cost > a.cost) ? -1 : 0);
                });
                async.forEachOfSeries(gameItems, function (item, key, cb) {
                    var inventoryItem = items.filter(function (o, i, a) {
                        return o.id === item.id;
                    });
                    if (inventoryItem && inventoryItem[0]) {
                        inventoryItem = inventoryItem[0];
                        if (item.cost * 100 <= feeSize && item.owner !== user.steamID.getSteamID64()) {
                            feeSize -= item.cost * 100;
                            feeItems++;
                        } else {
                            itemsToSend.push(inventoryItem);
                        }
                        cb();
                    } else {
                        cb();
                    }
                }, function () {
                    totalFee = ((totalFee - feeSize) / 100).toFixed(2);
                    self.emit('notification', 'Размер комиссии: ' + feeItems + ' предметов на сумму ' + totalFee + '$');
                    callback(itemsToSend);
                });
            });
        });
    });
};

Game.prototype.submit = function (winner, percentage, callback) {
    var self = this;
    self.db.collection('games').updateOne({id: self.id}, {
        $set: {
            winner: winner.steamID.getSteamID64(),
            winnerName: winner.name,
            percentage: percentage,
            winnerAvatar: winner.getAvatarURL()
        }
    }, {w: 1}, function (err, res) {
        if (err) {
            self.logger.error(err.stack || err);
            setTimeout(function () {
                self.submit(winner, percentage, callback);
            }, RETRY_INTERVAL / 2);
        } else {
            self.db.collection('users').find({steamID: winner.steamID.getSteamID64()}).toArray(function (err, users) {
                if (err) {
                    self.logger.error(err.stack || err);
                    setTimeout(function () {
                        self.submit(winner, percentage, callback);
                    }, RETRY_INTERVAL / 2);
                } else {
                    self.db.collection('users').updateOne({steamID: winner.steamID.getSteamID64()}, {
                        $set: {
                            won: users[0].won ? users[0].won + 1 : 1,
                            totalIncome: users[0].totalIncome ? users[0].totalIncome
                            + self.currentBank : self.currentBank,
                            maxWin: users[0].maxWin ? (users[0].maxWin < self.currentBank
                                ? self.currentBank : users[0].maxWin) : self.currentBank
                        }
                    }, {w: 1}, function (err1, r) {
                        if (err1) {
                            self.logger.error(err1.stack || err1);
                            setTimeout(function () {
                                self.submit(winner, percentage, callback);
                            }, RETRY_INTERVAL / 2);
                        } else {
                            callback();
                        }
                    });
                }
            });
        }
    });
}

Game.prototype.sendWonItems = function (items, winner, token, callback) {
    var self = this;
    if (token === null)
        self.getUserToken(winner.steamID.getSteamID64(), function (userToken) {
            self.steamHelper.sendItems(winner, userToken, items, 'Ваш выигрыш на сайте ' +
                'DOTA2BETS.RU в игре №' + self.id, callback);
        });
    else {
        self.steamHelper.sendItems(winner, token, items, 'Ваш выигрыш на сайте ' +
            'DOTA2BETS.RU в игре №' + self.id, callback);
    }
}

Game.prototype.update = function (callback) {
    var self = this;
    self.db.collection('games').updateOne({id: self.id}, {$set: {bank: self.currentBank}}, {w: 1}, function (err, result) {
        if (err) {
            self.logger.error('Не удалось обновить информацию об игре');
            setTimeout(function () {
                self.update(callback);
            }, RETRY_INTERVAL / 10);
        } else {
            self.sortBetsByPlayer(function () {
                self.recalculateChance(function () {
                    if (self.state === State.WAITING && Object.keys(self.betsByPlayer).length >= 2) {
                        var start = Date.now();
                        self.db.collection('games').updateOne({id: self.id}, {$set: {startTime: start}}, {w: 1}, function (err1, result) {
                            if (err1) {
                                self.logger.error('Не удалось обновить информацию об игре');
                                setTimeout(function () {
                                    self.update(callback);
                                }, RETRY_INTERVAL / 10);
                            } else {
                                self.startTime = start;
                                if (self.gameTimer <= 0)
                                    self.gameTimer = self.info.gameDuration;
                                self.startTimer();
                                callback();
                            }
                        });
                    } else {
                        self.getAllItems(function (items) {
                            if (items.length === self.info.maxItems) {
                                self.roll(callback);
                            } else {
                                if (callback)
                                    callback();
                            }
                        });
                    }
                })
            });
        }
    });
}

Game.prototype.resume = function (data) {
    var self = this;
    self.state = data.state;
    if (data.state !== State.PAUSED && data.winner && data.startTime > 0 &&
        Date.now() - data.startTime >= self.info.gameDuration * 1000 && data.state !== State.ACTIVE) {
        if (data.state !== State.SENT) {
            self.steamHelper.getSteamUser(data.winner, function (user) {
                self.sortWonItems(user, function (items) {
                    self.sendWonItems(items, user, null, function () {
                        self.submit(user, (self.betsByPlayer[data.winner].totalCost / self.currentBank).toFixed(2), function () {
                            self.setState(State.SENT, function () {
                                var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper,
                                    self.info, self.logger);
                                self.emit('newGame', newGame);
                            });
                        });
                    });
                });
            });
        } else {
            var newGame = new Game(self.id + 1, self.db, self.marketHelper, self.steamHelper,
                self.info, self.logger);
            self.emit('newGame', newGame);
        }
    } else {
        self.winner = data.winner;
        self.currentBank = data.bank;
        self.bets = data.bets;
        self.float = data.float;
        self.hash = data.hash;
        self.startTime = data.startTime;
        self.sortBetsByPlayer(function () {
            if (self.state === State.PAUSED) {
                self.gameTimer = data.pauseTimer;
            } else if (data.startTime > 0) {
                if (Date.now() - data.startTime >= self.info.gameDuration * 1000) {
                    self.roll();
                } else {
                    self.gameTimer = Math.max(1, Number(((Date.now() - data.startTime) / 1000).toFixed(0)));
                    self.startTimer();
                }
            } else if (Object.keys(self.betsByPlayer).length >= 2) {
                var start = Date.now();
                self.update();
            }
        });

    }
}

Game.prototype.startTimer = function () {
    var self = this;
    if (self.state !== State.PAUSED) {
        self.setState(State.ACTIVE, function () {
            self.timerID = setInterval(function () {
                self.gameTimer--;
                self.emit('timerChanged', self.gameTimer);
                if (self.gameTimer <= 0) {
                    clearInterval(self.timerID);
                    self.roll();
                }
            }, 1000);
        });
    }
}

module.exports = Game;