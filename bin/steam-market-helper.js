/**
 * Created by BronzeBee on 10.05.2016.
 */
var request = require("request");
var fs = require("fs");


/**
 * Класс для операций над торговой площадкой
 * @constructor
 */
function MarketHelper(callback, config, configPath, stdOut, stdErr, APIKey) {
    var _this = this;
    _this.config = config ? config : {lastPriceUpdate: 0, priceUpdateInterval: 60 * 1000 * 60, bptfAPIKey: APIKey};
    if (!_this.config.bptfAPIKey) {
        throw new Error("Backpack.tf API Key не задан");
    }
    _this.configPath = configPath ? configPath : "./config.json";
    _this.taskID = -1;
    _this.priceData = {};
    _this.printInfo = stdOut ? stdOut : console.log;
    _this.printErr = stdErr ? stdErr : console.log;
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
    _this.printInfo("Идет кэширование цен, может занять до 1 минуты");
    var url = "http://backpack.tf/api/IGetMarketPrices/v1/?format=json&appid=" + _this.config["appID"] + "&key=" + _this.config["bptfAPIKey"];
    request(url, function (err, response, body) {
        if (err) {
            _this.printErr("Не удалось прокэшировать цены");
            _this.printErr(err.stack || err);
            _this.printErr("Повторная попытка через 3с.");
            setTimeout(function () {
                self.cachePrices(callback);
            }, 3000);
        } else {
            var data = JSON.parse(body);
            if (Number(data.response.success) == 1) {
                _this.priceData = data.response.items;
                fs.writeFileSync("./prices.json", JSON.stringify(_this.priceData, null, 3), "utf-8");
                _this.printInfo("Цены успешно прокэшированы");
                _this.config["lastPriceUpdate"] = Date.now();
                fs.writeFileSync(_this.configPath, JSON.stringify(_this.config, null, 3), "utf-8");
                _this.taskID = setTimeout(function () {
                    self.cachePrices(function () {
                    });
                }, Number(_this.config["priceUpdateInterval"]) * 1000);
                callback();
            } else {
                _this.printErr("Не удалось прокэшировать цены:");
                _this.printErr(data.response.message);
                _this.printErr("Повторная попытка через 3с.");
                setTimeout(function () {
                    self.cachePrices(callback);
                }, 3000);
            }
        }
    });
}

module.exports = MarketHelper;