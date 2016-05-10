/**
 * Created by BronzeBee on 09.04.2016.
 */

/**
 * Подключем модули
 * @type {exports|module.exports}
 */
var fs = require("fs");
var winston = require("winston");
var moment = require("moment");
var SteamUser = require("steam-user");
var SteamCommunityContainer = require("steamcommunity");
var SteamTotp = require("steam-totp");
var TradeOfferManager = require("steam-tradeoffer-manager");
var mongodb = require("mongodb");
var MongoClient = mongodb.MongoClient;
var crypto = require("crypto");
var async = require("async");
var request = require('request');
var io = require("socket.io");

var FORCECHECK = false;

var RELOGIN = false;

/**
 * База данных
 */
var db;

/**
 * Авторизирован ли бот
 * @type {boolean}
 */
var LOGGED_IN = false;

/**
 * Запущена ли рулетка
 * @type {boolean}
 */
var ROLLING = false;

/**
 * Выводит все необходимое в консоль и в файл
 */
var logger = createLogger();

/**
 * Конфигурация бота
 */
var config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

/**
 * Пользователи, которым будут отправляться уведомления в Steam
 * @type {Array}
 */
var notificationUsers = [];

/**
 * Инициализируем клиент Steam и менеджер обменов
 * @type {SteamUser|exports|module.exports}
 */
var steamClient = new SteamUser();
var tradeManager;
var steamCommunity = new SteamCommunityContainer();

/**
 * Объект, несущий информацию о текущей игре
 */
var currentGame;

/**
 * Общая информация об играх (из базы данных)
 * @type {{}}
 */
var globalInfo = {};

/**
 * Выделил все операции с маркетом в отдельный объект
 * @type {MarketHelper}
 */
var marketHelper;

/**
 * Запускаем бота
 */
main();

function main() {
    logger.info("********** Конфуций v2.21 **********");
    logger.info("Установка соединения с базой данных");
    connectToDB(function (database) {
        db = database;
        initInfo(function () {
            auth();
        });
    });
}

/**
 * Достаем общую инфомацию из базы данных
 * @param callback функция обратного вызова
 */
function initInfo(callback) {
    var info = db.collection("info").find();
    info.toArray(function (err, items) {
        if (err) {
            logger.error(err.stack || err);
            terminate();
        } else {
            async.forEachOfSeries(items, function (data, index, cb) {
                globalInfo[data.name] = data.value;
                cb();
            }, function () {
                callback();
            });
        }
    });
}

/**
 * Загружаем информацию об игре
 * @param callback функция обратного вызова
 */
function initGame(callback) {
    db.collection("games").find({id: globalInfo["current_game"]}).toArray(function (err, items) {
        if (err) {
            logger.error(err.stack || err);
            terminate();
        } else {
            if (items.length > 0) {
                var gameData = items[0];
                currentGame = new Game(globalInfo["current_game"]);
                async.forEachOfSeries(gameData.items, function (i, k, c) {
                    i.cost = (i.cost * 100).toFixed(0);
                    c();
                }, function () {
                    currentGame.resume(gameData.start_time, gameData.bank, gameData.items, gameData.winner, gameData.float, gameData.hash, gameData.state);
                    callback();
                });
            } else {
                currentGame = new Game(globalInfo["current_game"]);
                currentGame.saveToDB(function () {
                    callback();
                });
            }
        }
    });
}


/**
 * Авторизируемся через Steam
 */
function auth() {
    var logOnOptions = config["logOnOptions"];
    logger.info("Установлен пользователь: " + logOnOptions.accountName);
    logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(logOnOptions.sharedSecret);
    logger.info("Авторизация");
    steamClient.setSentry(fs.readFileSync("./sentry.txt"));

    /**
     * В случае, если через 5 секунд бот по каким-либо
     * причинам все еще не залогинен, выключаемся.
     * (мера предосторожности)
     */
    setTimeout(function () {
        if (!LOGGED_IN) {
            logger.error("Авторизация не удалась");
            terminate();
        }
    }, 5000);

    steamClient.logOn(logOnOptions);
}

/**
 * Коннектим базу данных
 */
function connectToDB(callback) {
    MongoClient.connect(config.mongodb.url, function (err, db) {
        if (err) {
            logger.error("Не удалось соединиться с базой данных:");
            logger.error(err.stack || err);
            terminate();
        } else {
            logger.info("Соединение с базой данных установлено");
            db.collection("users").find({"notify": 1}).toArray(function (err, items) {
                if (err) {
                    logger.error(err.stack || err);
                    terminate();
                } else {
                    async.forEachOfSeries(items, function (data, key, cb) {
                        notificationUsers.push(data.steamid);
                        cb();
                    }, function () {
                        callback(db);
                    });
                }
            });

        }
    });
}

/**
 * Уведомляем царей об успешной авторизации
 */
steamClient.on('loggedOn', function () {
    LOGGED_IN = true;
    /**
     * Код авторизации больше не нужен
     */
    delete config.logOnOptions.twoFactorCode;
    steamClient.setPersona(SteamUser.Steam.EPersonaState.LookingToTrade);
    notifyAdmins(moment().format("HH:mm:ss") + " - Авторизирован.", true);
});

/**
 * Обрабатываем сообщения в чате
 */
steamCommunity.on('chatMessage', function (sender, text) {
    text = text.trim();
    if (config.admins.indexOf(sender.getSteamID64()) >= 0 && text.charAt(0) == "/") {
        var args = text.replace("/", "").split(" ");
        var command = args[0];
        args.splice(0, 1);
        executeCommand(command, args, sender.getSteamID64());
    }
});


/**
 * Генерируем API key и запускаем получение
 * новых кодов подтверждения
 */
steamClient.on('webSession', function (sessionID, cookies) {
    if (RELOGIN) {
        tradeManager.setCookies(cookies, function (err) {
            if (err) {
                logger.error("Не удалось получить API key");
                logger.error(err.stack || err);
                terminate();
                RELOGIN = false;
                return;
            } else {
                steamCommunity.setCookies(cookies);
                steamCommunity.chatLogon();
                steamCommunity.startConfirmationChecker(30000, config["logOnOptions"]["identitySecret"]);
                logger.info("Повторная авторизация выполнена");
                RELOGIN = false;
                setTimeout(function() {
                    notifyAdmins("Повторная веб-авторизация выполнена");
                }, 1500);
            }
        });
    } else {
        tradeManager = new TradeOfferManager({
            "steam": steamClient,
            "community": steamCommunity,
            "domain": "dota2bets.ru",
            "language": "en"
        });
        tradeManager.setCookies(cookies, function (err) {
            if (err) {
                logger.error("Не удалось получить API key");
                logger.error(err.stack || err);
                terminate();
                return;
            }
            logger.info("Получен API key: " + tradeManager.apiKey);
            steamCommunity.setCookies(cookies);
            steamCommunity.chatLogon();
            steamCommunity.startConfirmationChecker(30000, config["logOnOptions"]["identitySecret"]);

            marketHelper = new MarketHelper(function () {
                initGame(function () {
                    checkAcceptedTrades(function (items, totalCost) {
                        forceCheckOffers(function () {
                            if (items.length > 0) {
                                addItemsToGame(items, totalCost, function () {
                                    currentGame.updateGame(function () {
                                        notifyAdmins("Было восстановлено " + items.length + " предметов на сумму " + (totalCost / 100).toFixed(2) + "$", true);
                                    });
                                });
                            }
                            tradeManager.on("newOffer", function (offer) {
                                if (!FORCECHECK)
                                    handleTradeOffer(offer);
                            });

                            steamCommunity.on("sessionExpired", function (err) {
                                logger.error("Истекло время сессии");
                                logger.error("Выполняю повторную веб-авторизацию");
                                logger.error(err.stack || err);
                                RELOGIN = true;
                                var t = setInterval(function() {
                                    if (RELOGIN) {
                                        steamClient.webLogOn();
                                    } else {
                                        clearInterval(t);
                                    }
                                }, 3000);

                            });

                        });
                    });
                });
            });
        });
    }

});

function forceCheckOffers(callback, depth) {
    FORCECHECK = true;
    tradeManager.getOffers(1, null, function (err, sentOffers, receivedOffers) {
        if (err) {
            if (!depth)
                depth = 1;
            else
                depth++;
            logger.error(err.stack || err);
            if (depth < 5) {
                setTimeout(function () {
                    forceCheckOffers(callback, depth);
                }, 1500);
            }
        } else {
            async.forEachOfSeries(receivedOffers, function (offer, key, cb) {
                if (offer.state === 2) {
                    handleTradeOffer(offer);
                }
                cb();
            }, function () {
                FORCECHECK = false;
                callback();
            });
        }
    });
}

/**
 * Обрабатывает обмен
 * @param offer предложение об обмене
 */
function handleTradeOffer(offer) {
    if (globalInfo["trading"] === true && globalInfo["pause_timer"] < 0) {
        /**
         * Если новый обмен не активен или залагал,
         * пропускаем его
         */
        getToken(offer.partner.getSteamID64(), function (token) {
            if (token) {
                if (offer.state === 2 && !offer._isGlitched()) {
                    //socket.emit("event.process_offer", {steamid: offer.partner.getSteamID64()});
                    getSteamUser(offer.partner.getSteamID64(), function (user) {
                        notifyAdmins("Получено предложение об обмене #" + offer.id + " от " + user.name, true);
                        /**
                         * Удостоверимся, что пользователь только вносит предметы
                         */
                        if (offer.itemsToGive.length <= 0) {
                            /**
                             * Проверим, не скрыт ли профиль
                             */
                            if (user.privacyState === "public") {

                                /**
                                 * Обрабатываем предметы
                                 * @see {#processItems}
                                 */
                                processItems(offer, function (items, totalCost, appIDMatch, marketError) {
                                    /**
                                     * Удостоверимся, что все предметы из нужной игры
                                     */
                                    if (appIDMatch) {
                                        /**
                                         * Проверяем наличие других ошибок
                                         * @see {#processItems}
                                         */
                                        if (!marketError) {
                                            /**
                                             * Превосходит ли стоимость предметов минимальную ставку
                                             */
                                            if (totalCost >= Number(globalInfo["min_bet"]) * 100) {
                                                /**
                                                 * Удостоверимся, что число предметов за один обмен
                                                 * не превосходит максимальное разрешенное
                                                 */
                                                if (items.length <= globalInfo["max_items_per_trade"]) {
                                                    /**
                                                     * Проверяем, не станет ли общее число предметов в игре
                                                     * больше максимального
                                                     */
                                                    if (items.length + currentGame.items.length <= globalInfo["max_items"]) {
                                                        /**
                                                         * Проверим, не превышает кол-во предметов от данного пользователя
                                                         * максимальное разрешенное
                                                         */
                                                        if (!currentGame.activeBetters || !currentGame.activeBetters[user.steamID.getSteamID64()] || currentGame.activeBetters[user.steamID.getSteamID64()].count + items.length <= globalInfo["max_items_per_user"]) {
                                                            acceptOffer(offer, function (newItems) {
                                                                /**
                                                                 * Обязательно проверяем подтверждения через
                                                                 * мобильный аутентификатор
                                                                 */
                                                                steamCommunity.checkConfirmations();
                                                                //socket.emit("event.process_offer.success", {steamid: user.steamID.getSteamID64()});
                                                                notifyAdmins("Предложение #" + offer.id + " принято", true);

                                                                /**
                                                                 * Добавляем предметы в игру
                                                                 */

                                                                addItemsToGame(newItems, totalCost, function () {
                                                                    currentGame.updateGame(function () {

                                                                    });
                                                                });

                                                            });
                                                        } else {
                                                            declineOffer(offer, "кол-во предметов от одного пользователя не должно превышать " + globalInfo["max_items_per_user"], function () {
                                                                //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "too_many_items_from_user"});
                                                            });
                                                        }
                                                    } else {
                                                        declineOffer(offer, "общее кол-во предметов не должно превышать " + globalInfo["max_items"], function () {
                                                            //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "too_many_items"});
                                                        });
                                                    }
                                                } else {
                                                    declineOffer(offer, "обмен содержит больше " + globalInfo["max_items_per_trade"] + "предметов", function () {
                                                        //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "too_many_items_in_trade"});
                                                    });
                                                }
                                            } else {
                                                declineOffer(offer, "ставка меньше минимальной", function () {
                                                    //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "low_bet"});
                                                });
                                            }
                                        } else {
                                            declineOffer(offer, marketError.message, function () {
                                                //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: marketError.reason});
                                            });
                                        }
                                    } else {
                                        declineOffer(offer, "обмен содержит предметы из других игр", function () {
                                            //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "items_to_give"});
                                        });
                                    }
                                });

                            } else {
                                declineOffer(offer, "профиль пользователя скрыт", function () {
                                    //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "private_profile"});
                                });
                            }
                        } else {
                            async.forEachOfSeries(offer.itemsToGive, function (item, key, cb) {
                                console.log("[" + item.market_hash_name + "]");
                                console.log(item.id);
                                console.log(item.classid + "_" + item.instanceid);
                                cb();
                            }, function () {
                                declineOffer(offer, "попытка вывести предметы", function () {
                                    //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "items_to_give"});
                                });
                            });
                        }
                    });
                } else {
                    notifyAdmins("Найдено недействительное предложение об обмене (#" + offer.id + "), игнорирую", true);
                }
            } else {
                declineOffer(offer, "у пользователя отсутствует трейд-ссылка", function () {
                    //socket.emit("event.process_offer.fail", {steamid: user.steamID.getSteamID64(), reason: "no_trade_link"});
                });
            }
        });
    }
}


/**
 * Безопасно принимает обмен (5 попыток)
 * @param offer предложение обмена
 * @param callback функция обратного вызова
 * @param depth номер попытки
 */
function acceptOffer(offer, callback, depth) {
    var partnerID = offer.partner.getSteamID64();
    offer.accept(function (err) {
        if (err) {
            logger.error("Не удалось принять обмен");
            logger.error(err.stack || err);
            if (!depth)
                depth = 1;
            else
                depth++;
            if (depth < 5) {
                logger.error("Следующая попытка через 1.5с.");
                setTimeout(function () {
                    acceptOffer(offer, callback, depth);
                }, 1500);
            } else {
                declineOffer(offer, "неизвестная ошибка при принятии обмена", function () {
                    //socket.emit("event.process_offer.fail", {steamid: partnerID, reason: "steam_error"});
                });
            }
        } else {
            offer.getReceivedItems(false, function (err, newItems) {
                async.forEachOfSeries(newItems, function (i, k, cbf) {
                    i.owner = offer.partner.getSteamID64();
                    i.cost = marketHelper.getItemData(i.market_hash_name).value;
                    cbf();
                }, function () {
                    callback(newItems);
                });
            });

        }
    });
}

/**
 * Вносит предметы в игру
 * @param items массив предметов
 * @param totalCost полная стоимость предметов
 * @param callback функция обратного вызова
 */
function addItemsToGame(items, totalCost, callback) {
    var bank = currentGame.currentBank;
    async.forEachOfSeries(items, function (item, key, cb) {
        var newItem = {
            id: item.id,
            name: item.name,
            owner: item.owner,
            market_hash_name: item.market_hash_name,
            cost: (item.cost / 100).toFixed(2),
            image: item.getImageURL(),
            cost_from: bank + 1,
            cost_to: bank + item.cost,
        };
        addItemToDB(newItem,
            function () {
                bank += item.cost;
                currentGame.items.push(newItem);
                cb();
            });
    }, function () {
        currentGame.currentBank += totalCost;
        //socket.emit();
        callback();
    });
}

/**
 * Вносит предмет в базу данных
 * @param item предмет
 * @param callback функция обратного вызова
 */
function addItemToDB(item, callback) {
    db.collection("games").updateOne({id: currentGame.id}, {$push: {items: item}}, {w: 1}, function (err, result) {
        if (err) {
            logger.error("Ошибка при внесении предмета в базу данных");
            logger.error(err.stack || err);
            logger.error("Пытаюсь снова");
            setTimeout(function () {
                addItemToDB(item, callback);
            }, 1);
        } else {
            callback();
        }
    });
}

/**
 * Обрабатываем предметы; возвращаем следующее:
 *  items - обработанный массив предметов
 *  totalCost - их полная стоимость
 *  appIDMatch - имеют ли ВСЕ предметы заданный appID
 *  marketError - объект, содержащий описание ошибки маркета:
 *    message - сообщение об ошибке
 *    reason - код события для передачи по сокету
 * @param offer предложение обмена
 * @param callback функция обратного вызова
 */
function processItems(offer, callback) {
    var totalCost = 0;
    var appIDMatch = true;
    var items = offer.itemsToReceive;
    var marketError = false;
    async.forEachOfSeries(items, function (item, key, cb) {
        if (item.appid !== config["appID"]) {
            appIDMatch = false;
        } else {
            var marketInfo = marketHelper.getItemData(item.market_hash_name);
            if (!marketInfo) {
                marketError = {
                    message: "Предмета " + item.name + " нет на торговой площадке",
                    reason: "no_market_lots"
                };
            } else if (Number(marketInfo.quantity) < config["marketLotsRequired"]) {
                marketError = {
                    message: "Недостаточное кол-во лотов " + item.name + "на торговой площадке (" + marketInfo.quantity + ")",
                    reason: "not_enough_market_lots"
                };
            } else {
                totalCost += Number(marketInfo.value);
                item.owner = offer.partner.getSteamID64();
                item.cost = marketInfo.value;
            }
        }
        cb();
    }, function () {
        callback(items, totalCost, appIDMatch, marketError);
    });
}

/**
 *
 * @param callback функция обратного вызова
 * @param depth
 */
function checkAcceptedTrades(callback, depth) {
    tradeManager.getOffers(2, null, function (err, sentOffers, receivedOffers) {
        if (err) {
            if (!depth)
                depth = 1;
            else
                depth++;
            logger.error("Ошибка при загрузке обменов");
            logger.error(err.stack || err);
            logger.error("Следующая попытка через 1.5c");
            if (depth < 5) {
                setTimeout(function () {
                    checkAcceptedTrades(callback, depth);
                }, 1500);
            }
        } else {
            var itemsToAdd = [];
            var totalCost = 0;
            var oldGame = null;
            var usedItems = currentGame.items.reduce(function (map, obj) {
                map[obj.id] = obj;
                return map;
            }, {});
            async.forEachOfSeries(receivedOffers, function (offer, key, cb) {
                if (offer.state === 3) {
                    if (globalInfo.start_time > 0) {
                        if (offer.updated.getTime() >= globalInfo.start_time) {
                            offer.getReceivedItems(false, function (err1, newItems) {
                                if (err1) {
                                    if (!depth)
                                        depth = 1;
                                    else
                                        depth++;
                                    logger.error("Ошибка при загрузке обменов");
                                    logger.error(err1.stack || err1);
                                    logger.error("Следующая попытка через 1.5c");
                                    if (depth < 5) {
                                        setTimeout(function () {
                                            checkAcceptedTrades(callback, depth);
                                        }, 1500);
                                    }
                                } else {
                                    async.forEachOfSeries(newItems, function (item, key, cb1) {
                                        if (!usedItems[item.id]) {
                                            item.cost = marketHelper.getItemData(item.market_hash_name).value;
                                            item.owner = offer.partner.getSteamID64();
                                            itemsToAdd.push(item);
                                            totalCost += item.cost;
                                            cb1();
                                        } else {
                                            cb1();
                                        }
                                    }, function () {
                                        cb();
                                    });
                                }
                            });
                        } else {
                            cb();
                        }
                    } else if (currentGame.id !== 1) {
                        if (!oldGame) {
                            db.collection("games").find({id: currentGame.id - 1}).toArray(function (err2, games) {
                                if (err2) {
                                    if (!depth)
                                        depth = 1;
                                    else
                                        depth++;
                                    logger.error("Ошибка при загрузке обменов");
                                    logger.error(err2.stack || err2);
                                    logger.error("Следующая попытка через 1.5c");
                                    if (depth < 5) {
                                        setTimeout(function () {
                                            checkAcceptedTrades(callback, depth);
                                        }, 1500);
                                    }
                                } else {
                                    if (games && games[0]) {
                                        oldGame = games[0];
                                        if (offer.updated.getTime() >= Number(oldGame.finish_time)) {
                                            offer.getReceivedItems(false, function (err3, newItems) {
                                                if (err3) {
                                                    if (!depth)
                                                        depth = 1;
                                                    else
                                                        depth++;
                                                    logger.error("Ошибка при загрузке обменов");
                                                    logger.error(err3.stack || err3);
                                                    logger.error("Следующая попытка через 1.5c");
                                                    if (depth < 5) {
                                                        setTimeout(function () {
                                                            checkAcceptedTrades(callback, depth);
                                                        }, 1500);
                                                    }
                                                } else {
                                                    async.forEachOfSeries(newItems, function (item, key, cb3) {
                                                        if (!usedItems[item.id]) {
                                                            item.cost = marketHelper.getItemData(item.market_hash_name).value;
                                                            item.owner = offer.partner.getSteamID64();
                                                            itemsToAdd.push(item);
                                                            totalCost += item.cost;
                                                            cb3();
                                                        } else {
                                                            cb3();
                                                        }
                                                    }, function () {
                                                        cb();
                                                    });
                                                }
                                            });
                                        } else {
                                            cb();
                                        }
                                    } else {
                                        cb();
                                    }
                                }
                            });
                        } else {
                            if (offer.updated.getTime() >= Number(oldGame.finish_time)) {
                                offer.getReceivedItems(false, function (err4, newItems) {
                                    if (err4) {
                                        if (!depth)
                                            depth = 1;
                                        else
                                            depth++;
                                        logger.error("Ошибка при загрузке обменов");
                                        logger.error(err4.stack || err4);
                                        logger.error("Следующая попытка через 1.5c");
                                        if (depth < 5) {
                                            setTimeout(function () {
                                                checkAcceptedTrades(callback, depth);
                                            }, 1500);
                                        }
                                    } else {
                                        async.forEachOfSeries(newItems, function (item, key, cb5) {
                                            if (!usedItems[item.id]) {
                                                item.cost = marketHelper.getItemData(item.market_hash_name).value;
                                                item.owner = offer.partner.getSteamID64();
                                                itemsToAdd.push(item);
                                                totalCost += item.cost;
                                                cb5();
                                            } else {
                                                cb5();
                                            }
                                        }, function () {
                                            cb();
                                        });
                                    }
                                });
                            } else {
                                cb();
                            }
                        }
                    } else {
                        cb();
                    }
                } else {
                    cb();
                }

            }, function () {
                callback(itemsToAdd, totalCost);
            });
        }
    });
}

/**
 * Безопасно отклоняет обмен (5 попыток)
 * @param offer предложение обмена
 * @param callback функция обратного вызова
 * @param depth номер попытки
 */
function declineOffer(offer, reason, callback, depth) {
    offer.decline(function (err) {
        if (err) {
            logger.error("Не удалось отклонить обмен");
            logger.error(err.stack || err);
            if (!depth)
                depth = 1;
            else
                depth++;
            if (depth < 5) {
                logger.error("Следующая попытка через 3с.");
                setTimeout(function () {
                    declineOffer(offer, reason, callback, depth);
                }, 3000);
            }
        } else {
            notifyAdmins("Предложение обмена #" + offer.id + " отклонено: " + reason, true);
            callback();
        }
    });
}

/**
 * Безопасно получает информацию о пользователе (5 попыток)
 * @param id SteamID64 пользователя
 * @param callback функция обратного вызова
 * @param depth номер попытки
 */
function getSteamUser(id, callback, depth) {
    steamCommunity.getSteamUser(new SteamCommunityContainer.SteamID(id), function (err, user) {
        if (err) {
            logger.error("Ошибка при получении данных пользователя " + id);
            logger.error(err.stack || err);
            if (!depth)
                depth = 1;
            else
                depth++;
            if (depth < 5) {
                logger.error("Следующая попытка через 3с.");
                setTimeout(function () {
                    getSteamUser(id, callback, depth);
                }, 3000);
            }
        } else {
            callback(user);
        }
    });
}

/**
 * Отправляет сообщение всем царям
 * @param msg текст сообщения
 * @param echo логгировать ли сообщение [optional]
 */
function notifyAdmins(msg, echo) {
    if (echo)
        logger.info(msg);
    config.admins.forEach(function (admin) {
        if (notificationUsers.indexOf(admin) >= 0)
            steamClient.chatMessage(admin, msg);
    });
}

/**
 * Создаем логгер.
 * Последний файл вывода носит имя latest.log.
 * Предыдущий файл вывода переименовывается по
 * заранее записанной дате.
 */
function createLogger() {
    function formatter(args) {
        var date = moment().format("HH:mm:ss");
        var logMessage = "[" + date + " " + args.level.toUpperCase() + "]: " + args.message;
        return logMessage;
    }

    var dateString = moment().format("YYYY-MM-DD HH-mm-ss");
    if (fs.existsSync("./logs/confucius/logdata.json")) {
        var logData = JSON.parse(fs.readFileSync("./logs/confucius/logdata.json", "utf-8"));
        if (fs.existsSync("./logs/confucius/latest.log")) {
            fs.rename("./logs/confucius/latest.log", "./logs/confucius/" + logData["last_date"] + ".log", function () {
            });
        }
        logData["last_date"] = dateString;
        fs.writeFileSync("./logs/confucius/logdata.json", JSON.stringify(logData), "utf-8");
    } else {
        var logData = {"last_date": dateString};
        fs.writeFileSync("./logs/confucius/logdata.json", JSON.stringify(logData), "utf-8");
    }
    var logger = new winston.Logger({
        json: false,
        transports: [
            new (winston.transports.Console)({
                handleExceptions: true,
                json: false,
                formatter: formatter
            }),
            new (winston.transports.File)({
                filename: './logs/confucius/latest.log',
                handleExceptions: true,
                json: false,
                formatter: formatter
            })
        ]
    });
    return logger;
}

/**
 * Выходим из Steam и завершаем процесс
 * @param printf функция логгинга [optional]
 */
function terminate(printf) {
    if (printf)
        printf("Закрытие соединения и завершение работы");
    else
        logger.info("Закрытие соединения и завершение работы");
    if (LOGGED_IN) {
        steamCommunity.chatLogoff()
        steamClient.logOff();
    }
    if (db)
        db.close();
    if (marketHelper)
        clearTimeout(marketHelper.taskID);

    setTimeout(function () {
        process.exit(0);
    }, 2000);
}

/**
 * Класс, описывающий данные игры
 * @param id номер игры
 * @constructor
 */
function Game(id) {
    this.id = id;
    this.gameTimer = Number(config["gameDuration"]);
    this.currentBank = 0;
    this.items = [];
    this.float = Math.random();
    this.hash = crypto.createHash('md5').update(this.float + "").digest('hex');
    this.timerID = -1;
    this.state = "waiting";
    this.activeBetters = {};
    this.winner = null;
}

/**
 * Сортирует ставки по steamID поставивших
 * @param items массив предметов
 * @param callback функция обратного вызова
 */
Game.prototype.sortBetsByPlayer = function (items, callback) {
    var _this = this;
    var sortedItems = {};
    async.forEachOfSeries(items, function (item, index, cb) {
        if (sortedItems[item.owner]) {
            var data = marketHelper.getItemData(item.market_hash_name);
            sortedItems[item.owner].total_cost += data.value;
            sortedItems[item.owner].count++;
        } else {
            sortedItems[item.owner] = {total_cost: 0, count: 0, chance: 0};
            var data = marketHelper.getItemData(item.market_hash_name);
            sortedItems[item.owner].total_cost += data.value;
            sortedItems[item.owner].count++;
        }
        cb();

    }, function () {
        _this.activeBetters = sortedItems;
        _this.recalculateChance(function () {
            callback();
        });
    });
}

/**
 * Перерасчитывает шанс всех пользователей
 * @param callback функция обратного вызова
 */
Game.prototype.recalculateChance = function (callback) {
    var _this = this;
    async.forEachOfSeries(_this.activeBetters, function (data, key, cb) {
        _this.activeBetters[key].chance = (data.total_cost / _this.currentBank * 100).toFixed(2);
        cb();
    }, function () {
        callback();
    });
}

/**
 * Обновляет информацию об игре
 * @param callback функция обратного вызова
 */
Game.prototype.updateGame = function (callback, timer) {
    var _this = this;
    db.collection("games").updateOne({id: _this.id}, {$set: {bank: _this.currentBank}}, {w: 1}, function (err, result) {
        if (err) {
            logger.error("Не удалось обновить информацию об игре");
            setTimeout(function () {
                self.updateGame(callback, timer);
            }, 100);
        } else {
            _this.sortBetsByPlayer(_this.items, function () {
                _this.recalculateChance(function () {
                    if ((_this.state === "waiting" || timer) && Object.keys(_this.activeBetters).length >= 2) {
                        var start = Date.now();
                        db.collection("games").updateOne({id: _this.id}, {$set: {start_time: start}}, {w: 1}, function (err1, result) {
                            if (err1) {
                                logger.error("Не удалось обновить информацию об игре");
                                setTimeout(function () {
                                    self.updateGame(callback, timer);
                                }, 100);
                            } else {
                                globalInfo.start_time = start;
                                _this.gameTimer = timer ? timer : Number(config["gameDuration"]);
                                _this.start();
                                callback();
                            }
                        });
                    } else if (_this.items.length === globalInfo["max_items"]) {
                        _this.roll(function () {

                        });
                    } else {
                        callback();
                    }
                })
            });
        }
    });
}

/**
 * Изменяет статус игры
 * @param newState новый статус
 * @param callback функция обратного вызова
 */
Game.prototype.setState = function (newState, callback) {
    var _this = this;
    if (_this.state !== newState) {
        db.collection("games").updateOne({id: _this.id}, {$set: {state: newState}}, {w: 1}, function (err, result) {
            if (err) {
                logger.error("Не удалось обновить статус игры #" + _this.id);
                logger.error(err.stack || err);
                logger.error("Пытаюсь снова");
                setTimeout(function () {
                    self.setState(newState, callback);
                }, 500);
            } else {
                notifyAdmins("Статус игры #" + _this.id + " изменен с '" + _this.state + "' на '" + newState + "'", true);
                _this.state = newState;
                callback();
            }
        });
    } else {
        callback();
    }
}

/**
 * Если игра была прервана, возобновляем её
 * Все значения должны браться из базы данных
 * @param startTime время до конца игры (в секундах)
 * @param bank полная стоимость предметов в игре
 * @param items все предметы в текущей игре
 * @param winner SteamID64 победителя (или null)
 * @param float число раунда
 * @param hash хэш раунда
 */
Game.prototype.resume = function (startTime, bank, items, winner, float, hash, state) {
    var _this = this;
    _this.state = state;
    if (globalInfo["pause_timer"] < 0 && winner && startTime > 0 && Date.now() - startTime >= Number(config["gameDuration"]) * 1000 && state !== "active") {
        if (state !== "sent") {
            //отправить выигрыш
        } else {
            currentGame = new Game(_this.id + 1);
            currentGame.saveToDB(function () {
            });
        }
    } else {
        _this.winner = winner;
        _this.currentBank = bank;
        _this.items = items;
        _this.float = float;
        _this.hash = hash;
        _this.sortBetsByPlayer(_this.items, function () {
            if (globalInfo["pause_timer"] >= 0) {
                _this.gameTimer = globalInfo["pause_timer"];
            } else if (startTime > 0) {
                if (Date.now() - startTime >= Number(config["gameDuration"]) * 1000) {
                    _this.roll(function () {

                    });
                } else {
                    _this.gameTimer = Math.max(1, Number(((Date.now() - startTime) / 1000).toFixed(0)));
                    _this.start();
                }
            } else if (Object.keys(_this.activeBetters).length >= 2) {
                var start = Date.now();
                _this.updateGame(function () {
                    logger.info("Информация об игре обновлена");
                });
            }
        });

    }
}


Game.prototype.saveFinishTime = function (time, callback, depth) {
    var id = this.id;
    db.collection("games").updateOne({id: id}, {$set: {finish_time: time}}, {w: 1}, function (error, result) {
        if (error) {
            if (!depth)
                depth = 1;
            else
                depth++;
            logger.error(error.stack || error);
            if (depth < 5) {
                setTimeout(function () {
                    self.saveFinishTime(time, id, callback, depth);
                }, 1500);
            }
        } else {
            callback();
        }
    });
}

/**
 * Сохраняет ифнормацию об игре в базу
 * @param callback функция обратного вызова
 */
Game.prototype.saveToDB = function (callback) {
    var _this = this;
    db.collection("info").updateOne({name: "current_game"}, {$set: {value: _this.id}}, {w: 1}, function (error, result) {
        if (error) {
            logger.error(error.stack || error);
            setTimeout(function () {
                self.saveToDB(callback);
            }, 1500);
        } else {
            db.collection("games").insertOne({
                id: _this.id,
                start_time: -1,
                bank: _this.currentBank,
                items: _this.items,
                float: _this.float,
                hash: _this.hash,
                state: _this.state,
                finish_time: -1
            }, {w: 1}, function (err, result) {
                if (err) {
                    logger.error(err.stack || err);
                    setTimeout(function () {
                        _this.saveToDB(callback);
                    }, 1500);
                } else {
                    callback();
                }
            });
        }
    });

}

/**
 * Запускаем отсчет до конца игры
 */
Game.prototype.start = function () {
    if (globalInfo["pause_timer"] < 0) {
        var _this = this;
        _this.setState("active", function () {
            _this.timerID = setInterval(function () {
                _this.gameTimer--;
                //socket.emit("event.main_timer", _this.gameTimer);
                if (_this.gameTimer <= 0) {
                    clearInterval(_this.timerID);
                    _this.roll(function () {
                    });
                }
            }, 1000);
        });
    }
}

/**
 * Выбирает победителя
 * @param callback функция обратного вызова
 */
Game.prototype.selectWinner = function (callback) {
    var _this = this;
    var set = false;
    if (_this.winner) {
        callback(_this.winner);
    } else {
        var winnerNumber = Math.max((_this.currentBank * _this.float).toFixed(0) * 1, 1);
        async.forEachOfSeries(_this.items, function (item, key, cb) {
            if (winnerNumber >= Number(item.cost_from) && winnerNumber <= Number(item.cost_to)) {
                set = true;
                callback(item.owner);
            } else {
                cb();
            }
        }, function () {
            if (!set)
                callback(null);
        });
    }

}

/**
 * Запускает рулетку
 * @param callback функция обратного вызова
 */
Game.prototype.roll = function (callback) {
    ROLLING = true;
    var _this = this;
    _this.selectWinner(function (winnerID) {
        var newGame = new Game(_this.id + 1);
        currentGame = newGame;
        getSteamUser(winnerID, function (user) {
            notifyAdmins("Игра #" + _this.id + " завершена, победитель: " + user.name)
            //socket.emit("event.roll", {winnerID, user.name, user.getAvatarURL()});
            _this.saveFinishTime(Date.now(), function () {
                _this.setState("rolling", function () {
                    setTimeout(function () {
                        var time = Date.now();
                        loadInventory(function (items) {
                            var itemsToSend = [];
                            var gameItems = _this.items;
                            var discount = user.name.toLowerCase().indexOf("dota2bets.ru") >= 0 ? 0.5 : 1;
                            var feeSize = (_this.currentBank * Number(globalInfo["fee"]) * discount / 100).toFixed(0);
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
                                    if (item.cost * 100 <= feeSize && item.owner !== winnerID) {
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
                                notifyAdmins("Размер комиссии: " + feeItems + " предметов на сумму " + totalFee + "$");
                                sendItems(winnerID, itemsToSend, "Ваш выигрыш на сайте DOTA2BETS.RU в игре №" + _this.id, function (offer) {
                                    steamCommunity.checkConfirmations();
                                    _this.submitWinner(user, (_this.activeBetters[winnerID].total_cost / _this.currentBank).toFixed(2), function () {
                                        _this.finish(winnerID, function () {
                                            _this.setState("sent", function () {
                                                ROLLING = false;
                                                var waitTimer = Date.now() - time;
                                                if (waitTimer > 0) {
                                                    setTimeout(function () {
                                                        //socket.emit("event.update");
                                                    }, waitTimer);
                                                } else {
                                                    //socket.emit("event.update");
                                                }
                                                newGame.saveToDB(function () {
                                                    callback();
                                                });

                                            });
                                        });
                                    });
                                });
                            });
                        });
                    }, config["rouletteDuration"]);
                });
            });

        });
    });
}

/**
 * Вносит данные победителя в базу
 * @param winner steamID64 победителя
 * @param percentage шанс на победу (в процентах)
 * @param callback функция обратного вызова
 */
Game.prototype.submitWinner = function (winner, percentage, callback) {
    var _this = this;
    db.collection("games").updateOne({id: _this.id}, {
        $set: {
            winner: winner.steamID.getSteamID64(),
            winner_name: winner.name,
            percentage: percentage,
            winner_avatar: winner.getAvatarURL()
        }
    }, {w: 1}, function (err, res) {
        if (err) {
            logger.error(err.stack || err);
            setTimeout(function () {
                self.submitWinner(winner, percentage, callback);
            }, 1500);
        } else {
            callback();
        }
    });
}

/**
 * Обновляет информацию в профиле победителя (кол-во побед и т.д.)
 * @param winner steamID64 победителя
 * @param callback функция обратного вызова
 */
Game.prototype.finish = function (winner, callback) {
    var _this = this;
    db.collection("users").find({steamid: winner}).toArray(function (err, users) {
        if (err) {
            logger.error(err.stack || err);
            setTimeout(function () {
                self.finish(winner, callback);
            }, 1500);
        } else {
            db.collection("users").updateOne({steamid: winner}, {
                $set: {
                    won: users[0].won + 1,
                    total_income: users[0].total_income + _this.currentBank,
                    max_win: users[0].max_win < _this.currentBank ? _this.currentBank : users[0].max_win
                }
            }, {w: 1}, function (err1, r) {
                if (err1) {
                    logger.error(err1.stack || err1);
                    setTimeout(function () {
                        _this.finish(winner, callback);
                    }, 1500);
                } else {
                    callback();
                }
            });
        }
    });
}

/**
 * Отправляет предметы заданному пользователю
 * @param user steamID64 пользователя
 * @param items массив с предметами
 * @param msg сообщение к обмену
 * @param callback функция обратного вызова
 */
function sendItems(user, items, msg, callback) {
    var _this = this;
    var offer = tradeManager.createOffer(user);
    offer.addMyItems(items);
    getToken(user, function (token) {
        offer.send(msg, token, function (err, result) {
            if (!err) {
                callback(offer);
            } else {
                logger.error("Не удалось отправить трейд");
                logger.error(err.stack || err);
                setTimeout(function () {
                    sendItems(user, items, callback);
                }, 3000);
            }
        });
    });
}

/**
 * Загружает инвентарь бота
 * @param callback функция обратного вызова
 */
function loadInventory(callback) {
    tradeManager.loadInventory(config["appID"], 2, true, function (err, items) {
        if (err) {
            logger.error("Не удалось загрузить инвентарь");
            logger.error(err.stack || err);
            setTimeout(function () {
                loadInventory(callback);
            }, 1500);
        } else {
            callback(items);
        }
    });
}

/**
 * Передает идентификатор ссылки на обмен
 * данного ползователя
 * @param steamid steamID64 пользователя
 * @param callback функция обратного вызова
 */
function getToken(steamid, callback) {
    db.collection("users").find({steamid: steamid}).toArray(function (err, users) {
        if (err) {
            logger.error(err.stack || err);
            setTimeout(function () {
                getToken(steamid, callback);
            }, 1500);
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

/**
 * Передает массив с предметами, находящимися в
 * отправленных обменах
 * @param callback функция обратного вызова
 * @param depth
 */
function getQueuedItems(callback, depth) {
    tradeManager.getOffers(1, null, function (err, sentOffers, receivedOffers) {
        if (err) {
            if (!depth)
                depth = 1;
            else
                depth++;
            logger.error("Ошибка при загрузке обменов");
            logger.error(err.stack || err);
            logger.error("Следующая попытка через 1.5c");
            if (depth < 5) {
                setTimeout(function () {
                    getQueuedItems(callback, depth);
                }, 1500);
            }
        } else {
            var queuedItems = [];
            async.forEachOfSeries(sentOffers, function (offer, key, cb) {
                if (offer.state === 2)
                    queuedItems = queuedItems.concat(offer.itemsToGive);
                cb();
            }, function () {
                callback(queuedItems.map(function (item) {
                    return item.id;
                }));
            });
        }
    });
}

/**
 * Передает информацию об отправленных ботом обменах
 * в следующем формате:
 * {
 *  offerid - номер обмена
 *  receiver - имя получателя
 *  receiverid - steamID64 получателя
 *  size - число предметов в обмене
 * }
 * @param callback функция обратного вызова
 * @param depth
 */
function getActiveTrades(callback, depth) {
    tradeManager.getOffers(1, null, function (err, sentOffers, receivedOffers) {
        if (err) {
            if (!depth)
                depth = 1;
            else
                depth++;
            logger.error("Ошибка при загрузке обменов");
            logger.error(err.stack || err);
            logger.error("Следующая попытка через 1.5c");
            if (depth < 5) {
                setTimeout(function () {
                    getActiveTrades(callback, depth);
                }, 1500);
            }
        } else {
            var trades = [];
            async.forEachOfSeries(sentOffers, function (offer, key, cb) {
                if (offer.state === 2) {
                    getSteamUser(offer.partner.getSteamID64(), function (user) {
                        trades.push({
                            offerid: offer.id,
                            receiver: user.name,
                            receiverid: offer.partner.getSteamID64(),
                            size: offer.itemsToGive.length
                        });
                        cb();
                    });
                } else {
                    cb();
                }
            }, function () {
                callback(trades);
            });
        }
    });
}

/**
 * Выполняет соответствующую команду
 * @param command название команды
 * @param args аргументы
 * @param sender SteamID отправителя
 */
function executeCommand(command, args, sender) {
    switch (command) {
        case "terminate":
        {
            notifyAdmins("Пользователь " + sender + " использовал команду terminate");
            var msg = "الله أكبر";
            steamClient.chatMessage(sender, msg);
            steamClient.chatMessage(sender, "BOOM");
            setTimeout(function () {
                terminate();
            }, 2000);
            break;
        }
        case "roll":
        {
            if (Object.keys(currentGame.activeBetters).length >= 2) {
                if (!ROLLING) {
                    steamClient.chatMessage(sender, "Запуск рулетки");
                    clearInterval(currentGame.timerID);
                    currentGame.roll(function () {

                    });
                } else {
                    steamClient.chatMessage(sender, "Ошибка: рулетка уже запущена");
                }
            } else {
                steamClient.chatMessage(sender, "Невозможно запустить рулетку: недостаточно игроков");
            }
            break;
        }
        case "status" :
        {
            steamClient.chatMessage(sender, "Текущая игра: " + currentGame.id);
            steamClient.chatMessage(sender, "Кол-во участников: " + (currentGame.activeBetters ? Object.keys(currentGame.activeBetters).length : 0));
            steamClient.chatMessage(sender, "Кол-во предметов: " + currentGame.items.length);
            steamClient.chatMessage(sender, "Статус игры: " + currentGame.state);
            if (globalInfo["pause_timer"] >= 0) {
                steamClient.chatMessage(sender, "В данный момент игра приостановлена");
            }
            steamClient.chatMessage(sender, "Время до конца игры: " + currentGame.gameTimer);
            steamClient.chatMessage(sender, "Банк: " + (currentGame.currentBank / 100).toFixed(2) + "$");
            currentGame.selectWinner(function (steamid) {
                if (!steamid) {
                    steamClient.chatMessage(sender, "Потенциальный победитель: не выбран");
                } else {
                    getSteamUser(steamid, function (user) {
                        steamClient.chatMessage(sender, "Потенциальный победитель: " + user.name);
                    });
                }

            });
            break;
        }
        case "timeleft" :
        {
            steamClient.chatMessage(sender, "Время до конца игры: " + currentGame.gameTimer);
            break;
        }
        case "winner" :
        {
            currentGame.selectWinner(function (steamid) {
                if (!steamid) {
                    steamClient.chatMessage(sender, "Потенциальный победитель: не выбран");
                } else {
                    getSteamUser(steamid, function (user) {
                        steamClient.chatMessage(sender, "Потенциальный победитель: " + user.name);
                    });
                }
            });
            break;
        }
        case "notifications":
        {
            if (args.length != 1) {
                steamClient.chatMessage(sender, "Использование: /notifications [on/off/status]");
            } else {
                if (args[0] === "status") {
                    if (notificationUsers.indexOf(sender) >= 0) {
                        steamClient.chatMessage(sender, "Уведомления сейчас ВКЛЮЧЕНЫ");
                    } else {
                        steamClient.chatMessage(sender, "Уведомления сейчас ОТКЛЮЧЕНЫ");
                    }
                } else if (args[0] === "on") {
                    db.collection("users").updateOne({steamid: sender}, {$set: {notify: 1}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            notificationUsers.push(sender);
                            steamClient.chatMessage(sender, "Уведомления были ВКЛЮЧЕНЫ");
                        }
                    });
                } else if (args[0] === "off") {
                    db.collection("users").updateOne({steamid: sender}, {$set: {notify: 0}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            notificationUsers.splice(notificationUsers.indexOf(sender), 1);
                            steamClient.chatMessage(sender, "Уведомления были ОТКЛЮЧЕНЫ");
                        }
                    });
                } else {
                    steamClient.chatMessage(sender, "Использование: /notifications [on/off/status]");
                }
            }
            break;
        }
        case "trading":
        {
            if (args.length != 1) {
                steamClient.chatMessage(sender, "Использование: /trading [on/off/status]");
            } else {
                if (args[0] === "status") {
                    if (globalInfo["trading"] === true) {
                        steamClient.chatMessage(sender, "Обработка обменов сейчас ВКЛЮЧЕНА");
                    } else {
                        steamClient.chatMessage(sender, "Обработка обменов сейчас ОТКЛЮЧЕНА");
                    }
                } else if (args[0] === "on") {
                    db.collection("info").updateOne({name: "trading"}, {$set: {value: true}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            globalInfo["trading"] = true;
                            steamClient.chatMessage(sender, "Обработка обменов была ВКЛЮЧЕНА");
                            forceCheckOffers(function () {

                            });
                        }
                    });
                } else if (args[0] === "off") {
                    db.collection("info").updateOne({name: "trading"}, {$set: {value: false}}, {w: 1}, function (err, result) {
                        if (err) {
                            steamClient.chatMessage(sender, "Произошла ошибка, попытайтесь снова");
                            logger.error(err.stack || err);
                        } else {
                            globalInfo["trading"] = false;
                            steamClient.chatMessage(sender, "Обработка обменов была ОТКЛЮЧЕНА");
                        }
                    });
                } else {
                    steamClient.chatMessage(sender, "Использование: /trading [on/off/status]");
                }
            }
            break;
        }
        case "iteminfo":
        {
            if (args.length <= 0) {
                steamClient.chatMessage(sender, "Использование: /iteminfo [назание предмета]");
            } else {
                var name = args.join(" ").trim();
                var item = marketHelper.getItemData(name);
                if (item) {
                    steamClient.chatMessage(sender, "Последнее обновление: " + moment(item.last_updated + ".000", "X").format("DD.MM.YY, HH:mm:ss"));
                    steamClient.chatMessage(sender, "Кол-во лотов на маркете: " + item.quantity);
                    steamClient.chatMessage(sender, "Цена: " + (Number(item.value) / 100).toFixed(2) + "$");
                } else {
                    steamClient.chatMessage(sender, "Предмет не найден");
                }
            }
            break;
        }
        case "sendall":
        {
            getQueuedItems(function (itemIDs) {
                var usedItems = currentGame.items.reduce(function (map, obj) {
                    map[obj.id] = obj;
                    return map;
                }, {});
                loadInventory(function (items) {
                    var itemsToSend = items.map(function (i) {
                        if (!usedItems[i.id] && itemIDs.indexOf(i.id) < 0) {
                            return i;
                        } else {
                            return null;
                        }
                    }).filter(function (n) {
                        return n != undefined && n !== null
                    });
                    if (itemsToSend && itemsToSend.length > 0) {
                        sendItems(sender, itemsToSend, "Ваши предметы", function () {
                            steamCommunity.checkConfirmations();
                            steamClient.chatMessage(sender, "Трейд отправлен");
                        });
                    } else {
                        steamClient.chatMessage(sender, "Ошибка: предметы недоступны");
                    }
                });
            });
            break;
        }
        case "pause":
        {
            if (globalInfo["pause_timer"] < 0) {
                if (!ROLLING) {
                    var time = currentGame.gameTimer;
                    clearInterval(currentGame.timerID);
                    db.collection("info").updateOne({name: "pause_timer"}, {$set: {value: time}}, {w: 1}, function (err, result) {
                        if (err) {
                            logger.error(err.stack || err);
                            steamClient.chatMessage(sender, "Ошибка, попытайтесь снова");
                            currentGame.start();
                        } else {
                            globalInfo["pause_timer"] = time;
                            steamClient.chatMessage(sender, "Игра успешно приостановлена");
                            notifyAdmins("Пользователь " + sender + " приостановил игру", true);
                            //socket.emit("event.pause");
                        }
                    });
                } else {
                    steamClient.chatMessage(sender, "Невозможно приостановить игру, т.к. запущена рулетка");
                }
            } else {
                steamClient.chatMessage(sender, "Игра уже приостановлена!");
            }
            break;
        }
        case "unpause":
        {
            if (globalInfo["pause_timer"] >= 0) {
                db.collection("info").updateOne({name: "pause_timer"}, {$set: {value: -1}}, {w: 1}, function (err, result) {
                    if (err) {
                        logger.error(err.stack || err);
                        steamClient.chatMessage(sender, "Ошибка, попытайтесь снова");
                    } else {
                        var timer = globalInfo["pause_timer"];
                        globalInfo["pause_timer"] = -1;
                        currentGame.gameTimer = timer;
                        currentGame.updateGame(function () {
                            steamClient.chatMessage(sender, "Пауза была снята");
                            notifyAdmins("Пользователь " + sender + " возобновил игру", true);
                            forceCheckOffers(function () {

                            });
                            //socket.emit("event.unpause");
                        }, timer);
                    }
                });
            } else {
                steamClient.chatMessage(sender, "Игра не приостановлена!");
            }
            break;
        }
        case "trades":
        {
            getActiveTrades(function (tradesInfo) {
                for (var i = 0; i < tradesInfo.length; i++) {
                    steamClient.chatMessage(sender, "Обмен №" + tradesInfo[i].offerid + " c " + tradesInfo[i].receiver + " (" + tradesInfo[i].receiverid + "), " + tradesInfo[i].size + " предметов");
                }
            });
            break;
        }
        case "send":
        {
            getQueuedItems(function (itemIDs) {
                try {
                    var names = args.join(" ").trim().split(",").map(function (s) {
                        return s.trim();
                    });
                    var itemsToSend = [];
                    var usedItems = currentGame.items.reduce(function (map, obj) {
                        map[obj.id] = obj;
                        return map;
                    }, {});
                    loadInventory(function (items) {
                        async.forEachOfSeries(items, function (item, key, cb) {
                            if (names.indexOf(item.market_hash_name) >= 0 && !usedItems[item.id] && itemIDs.indexOf(item.id) < 0) {
                                itemsToSend.push(item);
                            }
                            cb();
                        }, function () {
                            if (itemsToSend && itemsToSend.length > 0) {
                                sendItems(sender, itemsToSend, "Ваши предметы", function () {
                                    steamCommunity.checkConfirmations();
                                    steamClient.chatMessage(sender, "Трейд отправлен");
                                });
                            } else {
                                steamClient.chatMessage(sender, "Ошибка: предметы недоступны");
                            }
                        });
                    });
                } catch (err) {
                    steamClient.chatMessage(sender, "Использование: /send [steamID]");
                }
            });
            break;
        }
        case "setwinner":
        {
            if (args.length != 1) {
                steamClient.chatMessage(sender, "Использование: /setwinner [steamID]");
            } else {
                if (currentGame.activeBetters.length > 0 && currentGame.activeBetters[args[0]]) {
                    db.collection("games").updateOne({id: currentGame.id}, {
                        $set: {
                            winner: args[0]
                        }
                    }, {w: 1}, function (err, res) {
                        if (err) {
                            steamClient.chatMessage(sender, "Ошибка, попытайтесь снова");
                        } else {
                            currentGame.winner = args[0];
                            steamClient.chatMessage(sender, "Победитель установлен");
                            getSteamUser(sender, function (user) {
                                getSteamUser(args[0], function (user2) {
                                    notifyAdmins(user.name + " установил пользователя " + user2.name + " победителем в игру №" + currentGame.id)
                                });
                            });
                        }
                    });
                } else {
                    steamClient.chatMessage(sender, "Ошибка: пользователь не найден");
                }
            }
            break;
        }
        case "clear":
        {
            var msg = "";
            for (var k = 0; k < 70; k++)
                msg += "\n";
            steamClient.chatMessage(sender, msg);
            break;
        }
        case "help":
        {
            steamClient.chatMessage(sender, "/status - выводит информацию о текущей игре");
            steamClient.chatMessage(sender, "/timeleft - выводит время (в секундах) до конца текущей игры");
            steamClient.chatMessage(sender, "/winner - выводит имя потенциального победителя текущей игры");
            steamClient.chatMessage(sender, "/setwinner [steamID64] - установить в текущую игру победителя с данным steamID64");
            steamClient.chatMessage(sender, "/notifications [on/off/status] - включить/отключить уведомленя");
            steamClient.chatMessage(sender, "/trading [on/off/status] - включить/отключить обработку обменов");
            steamClient.chatMessage(sender, "/send [market_hash_name, ...] - отправляет вам предметы с заданными market_hash_name");
            steamClient.chatMessage(sender, "/sendall - отправляет вам весь инвентарь бота");
            steamClient.chatMessage(sender, "/iteminfo [market_hash_name] - выводит информацию о предмете с данным market_hash_name");
            steamClient.chatMessage(sender, "/terminate - принудительно завершает работу бота");
            steamClient.chatMessage(sender, "/roll - запустить рулетку");
            steamClient.chatMessage(sender, "/clear - очистить консоль");
            steamClient.chatMessage(sender, "/pause - приостановить игру");
            steamClient.chatMessage(sender, "/unpuase - возобновить игру");
            steamClient.chatMessage(sender, "/trades - выводит информацию об активных трейдах, отправленных ботом");
            steamClient.chatMessage(sender, "/help - выводит список команд");
            break;
        }
        default:
        {
            steamClient.chatMessage(sender, "Неизвестная команда");
        }
    }

}

/**
 * Класс для операций над торговой площадкой
 * @constructor
 */
function MarketHelper(callback) {
    var _this = this;
    _this.taskID = -1;
    _this.priceData = {};
    if (!config["lastPriceUpdate"] || Date.now() - config["lastPriceUpdate"] >= Number(config["priceUpdateInterval"]) * 1000) {
        _this.cachePrices(callback);
    } else {
        _this.priceData = JSON.parse(fs.readFileSync("./prices.json", "utf-8"));
        _this.taskID = setTimeout(function () {
            _this.cachePrices(function () {

            });
        }, (Number(config["priceUpdateInterval"]) * 1000) - (Date.now() - Number(config["lastPriceUpdate"])));
        callback();
    }
}

/**
 * Возвращает объект со следующими данными о предмете:
 *  last_updated - последнее обновление цены (не используем)
 *  quantity - кол-во лотов на маркете (если меньше 10, отклоняем обмен)
 *  value - цена в центах
 * @param marketHashName
 * @returns {*}
 */
MarketHelper.prototype.getItemData = function (marketHashName) {
    return this.priceData[marketHashName];
}

/**
 * Кэширует цены всех предметов с маркета
 * в файл prices.json с помощью API backpack.tf
 */
MarketHelper.prototype.cachePrices = function (callback) {
    var _this = this;
    logger.info("Идет кэширование цен, может занять до 1 минуты");
    var url = "http://backpack.tf/api/IGetMarketPrices/v1/?format=json&appid=" + config["appID"] + "&key=" + config["bptfAPIKey"];
    request(url, function (err, response, body) {
        if (err) {
            logger.error("Не удалось прокэшировать цены");
            logger.error(err.stack || err);
            logger.error("Повторная попытка через 3с.");
            setTimeout(function () {
                self.cachePrices(callback);
            }, 3000);
        } else {
            var data = JSON.parse(body);
            if (Number(data.response.success) == 1) {
                _this.priceData = data.response.items;
                fs.writeFileSync("./prices.json", JSON.stringify(_this.priceData, null, 3), "utf-8");
                logger.info("Цены успешно прокэшированы");
                config["lastPriceUpdate"] = Date.now();
                fs.writeFileSync("./config.json", JSON.stringify(config, null, 3), "utf-8");
                _this.taskID = setTimeout(function () {
                    self.cachePrices(function () {
                    });
                }, Number(config["priceUpdateInterval"]) * 1000);
                callback();
            } else {
                logger.error("Не удалось прокэшировать цены:");
                logger.error(data.response.message);
                logger.error("Повторная попытка через 3с.");
                setTimeout(function () {
                    self.cachePrices(callback);
                }, 3000);
            }
        }
    });
}

/**
 * Обрабатываем непредвиденные ошибки
 * чтобы безопасно завершить работу
 */
process.on('uncaughtException', function (err) {
    var printf = logger ? logger.error : console.log;
    printf("Непредвиденная ошибка:");
    printf(err.stack || err);
    printf("Приложение будет закрыто");
    terminate(printf);
});

