/**
 * Copyright 2016 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
  "use strict";
  var mqtt = require("mqtt");
  var fs = require("fs");
  var bodyParser = require("body-parser");
  var devices = {};
  const https = require("https");
  const tls = require("tls");
  const semver = require("semver");
  const { v4: uuidv4 } = require("uuid");
  const packageJson = require("./package.json");

  // TODO: Remove after NodeJS fix it, more information
  // https://github.com/nodejs/node/issues/16196
  // https://github.com/nodejs/node/pull/16853
  // This is fixed in Node 10, but this workaround also supports LTS versions
  // https://github.com/nodejs/node/pull/15206
  if (
    semver.gte(process.version, "8.6.0") &&
    tls.DEFAULT_ECDH_CURVE === "prime256v1"
  ) {
    tls.DEFAULT_ECDH_CURVE = "auto";
  }

  // Config Node
  function alexaConf(n) {
    RED.nodes.createNode(this, n);
    this.username = this.credentials.username || n.username; // enable transition to credential store for username
    this.password = this.credentials.password;
    this.mqttserver = n.mqttserver;
    this.mqttport = n.mqttport;
    this.mqttca = n.mqttca;
    this.mqttcert = n.mqttcert;
    this.mqttkey = n.mqttkey;
    this.webapiurl = n.webapiurl;
    this.contextName = n.contextName || "memory"; // enable transition to user-configurable context storage
    this.users = {};
    var node = this;
    // console.log('***** received contextName: ' + n.contextName);
    // MQTT connect options
    var clientId = uuidv4(); // Generate UUID for use in clientId - clientId limit for Mosquitto is 65535 bytes
    var options = {
      username: node.username,
      password: node.password,
      //clientId: node.username,
      clientId: node.username + "-" + clientId,
      reconnectPeriod: 5000,      
      protocol: node.mqttca !== "" ? "mqtts" : "mqtt",
      host: node.mqttserver,
      port: node.mqttport || (node.mqttca !== "" ? 8883 : 1883)   
    };

    if (node.mqttca) {
      options = Object.assign(options, {
        ca: fs.readFileSync(node.mqttca),
        key: fs.readFileSync(node.mqttkey),
        cert: fs.readFileSync(node.mqttcert),
      });
    }

    getDevices(node.webapiurl, node.username, node.password, node.id);

    this.connect = function () {
      // Log version to console to assist future debugging
      node.log("Node-RED contrib version: v" + packageJson.version);
      node.log(
        "Connecting to Alexa/ Google Home Skill MQTT server: " +
        node.mqttserver +
        ", account username: " +
        node.username
      );
      node.client = mqtt.connect(options);
      node.client.setMaxListeners(0);

      node.client.on("connect", function () {
        node.log(
          "Successfully connected to Alexa/ Google Home Skill MQTT server: " +
          node.mqttserver +
          ", account username: " +
          node.username
        );
        node.setStatus({ text: "connected", shape: "dot", fill: "green" });
        node.client.removeAllListeners("message");
        node.client.subscribe("command/" + node.username + "/#");
        node.client.subscribe("message/" + node.username + "/#");
        node.client.on("message", function (topic, message) {
          var msg = JSON.parse(message.toString());
          //console.log("INFO, new MQTT message");
          //console.log("INFO, message:" + JSON.stringify(msg));

          // Message/ alert handler
          if (topic.indexOf("message") > -1) {
            var severity = msg.severity;
            var alert = msg.message;
            if (severity == "warn") {
              node.warn(alert);
            } else if (severity == "error") {
              node.error(alert);
            }
          }
          // Command handler
          if (topic.indexOf("command") > -1) {
            // Added Alexa message handler
            if (msg.hasOwnProperty("directive")) {
              //console.log("info", "Received Alexa MQTT message");
              var endpointId = msg.directive.endpoint.endpointId;
            }
            // Google Home message handler
            if (msg.hasOwnProperty("execution")) {
              //console.log("info", "Received Google Home MQTT message");
              var endpointId = msg.id;
            }

            for (var id in node.users) {
              if (node.users.hasOwnProperty(id)) {
                if (
                  node.users[id].device === endpointId &&
                  node.users[id].type == "alexa-smart-home-v3"
                ) {
                  //console.log("info", "Sending command message");
                  node.users[id].command(msg);
                }
              }
            }
          }
        });
      });

      node.client.on("offline", function () {
        node.setStatus({ text: "disconnected", shape: "dot", fill: "red" });
      });

      node.client.on("reconnect", function () {
        node.warn(
          "Re-connecting to Alexa/ Google Home Skill MQTT server: " +
          node.mqttserver +
          ", account username: " +
          node.username
        );
        node.setStatus({ text: "reconnecting", shape: "ring", fill: "red" });
      });

      node.client.on("error", function (err) {
        //console.log(err);
        node.setStatus({ text: "disconnected", shape: "dot", fill: "red" });
        node.error(err);
      });
    };

    this.setStatus = function (status) {
      for (var id in node.users) {
        if (node.users.hasOwnProperty(id)) {
          node.users[id].status(status);
        }
      }
    };

    this.register = function (deviceNode) {
      node.users[deviceNode.id] = deviceNode;
      // Object.keys(node.users).length will only === 1 at *first* node registration, thus connect will only execute once
      if (Object.keys(node.users).length === 1) {
        node.connect();
      }
    };

    this.deregister = function (deviceNode, done) {
      delete node.users[deviceNode.id];

      if (Object.keys(node.users).length === 0) {
        //disconnect
        if (node.client && node.client.connected) {
          node.client.end(done);
        } else {
          node.client.end();
          done();
        }
      }

      done();
    };

    this.acknowledge = function (messageId, device, success) {
      var response = {
        messageId: messageId,
        success: success,
      };

      //console.log("info, Response: " + JSON.stringify(response));

      var topic = "response/" + node.username + "/" + device;
      if (node.client && node.client.connected) {
        node.client.publish(topic, JSON.stringify(response));
      }
    };

    // ##########################################################
    // Config Node Update State
    this.updateState = function (messageId, endpointId, payload, deviceName) {
      var response = {
        messageId: messageId,
        payload: {
          state: {
            brightness: payload.state.brightness,
            colorBrightness: payload.state.colorBrightness,
            colorHue: payload.state.colorHue,
            colorSaturation: payload.state.colorSaturation,
            colorTemperature: payload.state.colorTemperature,
            contact: payload.state.contact,
            input: payload.state.input,
            lock: payload.state.lock,
            motion: payload.state.motion,
            mute: payload.state.mute,
            percentage: payload.state.percentage,
            percentageDelta: payload.state.percentageDelta,
            playback: payload.state.playback,
            power: payload.state.power,
            rangeValue: payload.state.rangeValue,
            rangeValueDelta: payload.state.rangeValueDelta,
            temperature: payload.state.temperature,
            thermostatMode: payload.state.thermostatMode,
            thermostatSetPoint: payload.state.thermostatSetPoint,
            targetSetpointDelta: payload.state.targetSetpointDelta,
            volume: payload.state.volume,
            volumeDelta: payload.state.volumeDelta,
          },
        },
      };

      var topic = "state/" + node.username + "/" + endpointId;
      node.log(
        deviceName +
        " : sending state update, topic:" +
        topic +
        " message:" +
        JSON.stringify(response)
      );

      if (node.client && node.client.connected) {
        node.client.publish(topic, JSON.stringify(response));
      }
    };
    // ##########################################################

    this.on("close", function () {
      if (node.client && node.client.connected) {
        node.client.end();
      }
      //node.removeAllListeners();
      //delete devices[node.id];
    });
  }

  // Re-branded for v3 API
  RED.nodes.registerType("alexa-smart-home-v3-conf", alexaConf, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" },
    },
  });

  // Command Node
  function alexaHome(n) {
    RED.nodes.createNode(this, n);
    this.conf = RED.nodes.getNode(n.conf);
    this.confId = n.conf;
    this.device = n.device;
    this.topic = n.topic;
    this.acknowledge = n.acknowledge;
    this.name = n.name;
    this.type = n.type;

    var node = this;

    // Command Node Command Function
    node.command = function (message) {
      //console.log("message", message)

      var messageFormat;

      // Alexa-format message handler
      if (message.hasOwnProperty("directive")) {
        //console.log("Alexa message", message)
        messageFormat = "Alexa";
        var msg = {
          topic: node.topic || "",
          name: node.name,
          _messageId: message.directive.header.messageId,
          _endpointId: message.directive.endpoint.endpointId,
          _confId: node.confId,
          command: message.directive.header.name,
          extraInfo: message.directive.endpoint.cookie,
        };
      }

      // Google-Home format message handler
      else if (message.hasOwnProperty("execution")) {
        //console.log("Google Home message", message)
        messageFormat = "Google Home";
        var msg = {
          topic: node.topic || "",
          name: node.name,
          _messageId: message.requestId,
          _endpointId: message.execution.devices[0].id,
          _confId: node.confId,
          command: message.execution.execution[0].command,
          params: message.execution.execution[0].params,
        };
      }

      var respond = true;
      var messageId;
      var supportedCommand = true;

      //console.log("Message: " + JSON.stringify(message));

      // Alexa Message Handler
      if (messageFormat == "Alexa") {
        if (message.directive.header.hasOwnProperty("messageId")) {
          messageId = message.directive.header.messageId;
        }
        switch (message.directive.header.name) {
          case "Activate":
            // Scene Controller
            msg.payload = "ON";
            break;
          case "AdjustBrightness":
            // Brightness % command
            msg.payload = message.directive.payload.brightnessDelta;
            break;
          case "AdjustPercentage":
            // Percentage Controller command
            msg.payload = message.directive.payload.percentageDelta;
            break;
          case "AdjustRangeValue":
            // Range Controller command
            msg.payload = message.directive.payload.rangeValueDelta;
            break;
          case "AdjustTargetTemperature":
            // Thermostat command
            msg.payload = message.directive.payload.targetSetpointDelta.value;
            msg.temperatureScale =
              message.directive.payload.targetSetpointDelta.scale;
            break;
          case "AdjustVolume":
            // Alexa.StepSpeaker
            if (message.directive.payload.hasOwnProperty("volumeSteps")) {
              msg.payload = message.directive.payload.volumeSteps;
            }
            // Alexa.Speaker
            else if (message.directive.payload.hasOwnProperty("volume")) {
              msg.payload = message.directive.payload.volume;
            }
            break;
          case "ChangeChannel":
            // Change channel command
            if (
              typeof message.directive.payload.channel.number != "undefined"
            ) {
              msg.payload = message.directive.payload.channel.number;
            } else if (
              message.directive.payload.channelMetadata.hasOwnProperty("name")
            ) {
              msg.payload = message.directive.payload.channelMetadata.name;
            }
            break;
          case "DecreaseColorTemperature":
            // Increase Color Temperature command
            msg.payload = "DecreaseColorTemperature";
            break;
          case "FastForward":
            // FastForward command
            msg.payload = "FastForward";
            break;
          case "IncreaseColorTemperature":
            // Increase Color Temperature command
            msg.payload = "IncreaseColorTemperature";
            break;
          case "Lock":
            // Lock command
            msg.payload = "Lock";
            break;
          case "Next":
            // Next command
            msg.payload = "Next";
            break;
          case "Pause":
            // Pause command
            msg.payload = "Pause";
            break;
          case "Play":
            // Play command
            msg.payload = "Play";
            break;
          case "Previous":
            // Previous command
            msg.payload = "Previous";
            break;
          case "Rewind":
            // Rewind command
            msg.payload = "Rewind";
            break;
          case "SelectInput":
            // Select input command
            msg.payload = message.directive.payload.input;
            break;
          case "SetBrightness":
            // Brightness % command
            msg.payload = message.directive.payload.brightness;
            break;
          case "SetColor":
            // Color command
            msg.payload = message.directive.payload.color;
            break;
          case "SetColorTemperature":
            // Color command
            msg.payload = message.directive.payload.colorTemperatureInKelvin;
            break;
          case "SetMode":
            // SetMode command
            msg.payload = message.directive.payload.mode;
            break;
          case "SetMute":
            // Mute command
            if (message.directive.payload.mute == false) {
              msg.payload = "OFF";
            }
            if (message.directive.payload.mute == true) {
              msg.payload = "ON";
            }
            break;
          case "SetPercentage":
            // Percentage Controller  command
            msg.payload = message.directive.payload.percentage;
            break;
          case "SetRangeValue":
            // Range Controller  command
            msg.payload = message.directive.payload.rangeValue;
            break;
          case "SetTargetTemperature":
            // Thermostat command
            msg.payload = message.directive.payload.targetSetpoint.value;
            msg.temperatureScale =
              message.directive.payload.targetSetpoint.scale;
            break;
          case "SetThermostatMode":
            // Thermostat command
            msg.payload = message.directive.payload.thermostatMode.value;
            break;
          case "SetVolume":
            // Speaker command
            msg.payload = message.directive.payload.volume;
            break;
          case "StartOver":
            // StartOver command
            msg.payload = "StartOver";
            break;
          case "Stop":
            // Stop command
            msg.payload = "Stop";
            break;
          case "TurnOn":
            // Power-on command
            msg.payload = "ON";
            break;
          case "TurnOff":
            // Power-off command
            msg.payload = "OFF";
            break;
          case "Unlock":
            // Unlock command
            msg.payload = "Unlock";
            break;
          default:
            // Do not handle unsupported commands
            node.warn("Alexa command unsupported!");
            supportedCommand = false;
            break;
        }
      }

      // Google Home Message Handler
      else if (messageFormat == "Google Home") {
        if (message.hasOwnProperty("requestId")) {
          messageId = message.requestId;
        }
        switch (msg.command) {
          case "action.devices.commands.ActivateScene":
            msg.command = "Activate";
            msg.payload = "ON";
            break;
          case "action.devices.commands.BrightnessAbsolute":
            if (msg.params.hasOwnProperty("brightness")) {
              msg.command = "SetBrightness";
              msg.payload = msg.params.brightness;
            }
            break;
          case "action.devices.commands.ColorAbsolute":
            if (msg.params.color.hasOwnProperty("temperature")) {
              msg.command = "SetColorTemperature";
              msg.payload = msg.params.color.temperature;
            }
            if (msg.params.color.hasOwnProperty("spectrumHSV")) {
              msg.command = "SetColor";
              msg.payload = {
                hue: msg.params.color.spectrumHSV.hue,
                saturation: msg.params.color.spectrumHSV.saturation,
                brightness: msg.params.color.spectrumHSV.value,
              };
            }
            break;
          case "action.devices.commands.LockUnlock":
            if (msg.params.hasOwnProperty("lock")) {
              if (msg.params.lock == true) {
                msg.command = "Lock";
                delete msg.payload;
                msg.payload = "Lock";
              } else {
                msg.command = "Unlock";
                delete msg.payload;
                msg.payload = "Unlock";
              }
            }
            break;
          case "action.devices.commands.mediaPause":
            msg.command = "Pause";
            delete msg.payload;
            break;
          case "action.devices.commands.mediaResume":
            msg.command = "Play";
            delete msg.payload;
            break;
          case "action.devices.commands.mediaNext":
            msg.command = "Next";
            delete msg.payload;
            break;
          case "action.devices.commands.mediaPrevious":
            msg.command = "Previous";
            delete msg.payload;
            break;
          case "action.devices.commands.mediaStop":
            msg.command = "Stop";
            delete msg.payload;
            break;
          case "action.devices.commands.mediaSeekRelative":
            if (msg.params.relativePositionMs < 0) {
              msg.command = "Rewind";
            }
            if (msg.params.relativePositionMs > 0) {
              msg.command = "FastForward";
            }
            delete msg.payload;
            break;
          case "action.devices.commands.mediaSeekToPosition":
            if ((msg.params.absPositionMs = 0)) {
              msg.command = "StartOver";
            }
            delete msg.payload;
            break;
          case "action.devices.commands.OnOff":
            if (msg.params.on == true) {
              msg.command = "TurnOn";
              msg.payload = "ON";
            } else if (msg.params.on == false) {
              msg.command = "TurnOff";
              msg.payload = "OFF";
            }
            break;
          case "action.devices.commands.OpenClose":
            msg.command = "SetRangeValue";
            msg.payload = msg.params.openPercent;
            break;
          case "action.devices.commands.SetFanSpeed":
            msg.command = "SetRangeValue";
            msg.payload = msg.params.fanSpeed;
            break;
          case "action.devices.commands.setVolume":
            if (msg.params.hasOwnProperty("volumeLevel")) {
              msg.command = "SetVolume";
              msg.payload = msg.params.volumeLevel;
            }
            break;
          case "action.devices.commands.ThermostatTemperatureSetpoint":
            if (msg.params.hasOwnProperty("thermostatTemperatureSetpoint")) {
              msg.command = "SetTargetTemperature";
              msg.payload = msg.params.thermostatTemperatureSetpoint;
            }
            break;
          case "action.devices.commands.ThermostatSetMode":
            if (msg.params.hasOwnProperty("thermostatMode")) {
              msg.command = "SetThermostatMode";
              msg.payload = msg.params.thermostatMode.toUpperCase();
            }
            break;
          case "action.devices.commands.volumeRelative":
            if (msg.params.hasOwnProperty("volumeRelativeLevel")) {
              msg.command = "AdjustVolume";
              msg.payload = msg.params.volumeRelativeLevel;
            }
            break;
          default:
            // Do not handle unsupported commands
            node.warn("Google Assistant command unsupported!");
            supportedCommand = false;
            break;
        }
      }
      msg.acknowledge = {};
      if (node.acknowledge) {
        msg.acknowledge = true;
      } else {
        msg.acknowledge = false;
      }
      if (supportedCommand == true) {
        node.send(msg);
        if (node.acknowledge && respond && messageId) {
          node.conf.acknowledge(messageId, node.device, true);
        }
      }
    };

    if (node.conf) {
      node.conf.register(node);
    } else {
      node.warn("Unable to register device node, account not configured!");
    }

    node.on("close", function (done) {
      node.conf.deregister(node, done);
    });
  }

  // Re-branded for v3 API
  RED.nodes.registerType("alexa-smart-home-v3", alexaHome);

  // Think this is OK for v3 API
  function alexaHomeResponse(n) {
    RED.nodes.createNode(this, n);

    var node = this;

    node.on("input", function (msg) {
      if (msg._messageId && msg._endpointId && msg._confId) {
        var conf = RED.nodes.getNode(msg._confId);
        if (typeof msg.acknowledge == "boolean" && msg.acknowledge) {
          conf.acknowledge(msg._messageId, msg._endpointId, true);
        } else {
          conf.acknowledge(msg._messageId, msg._endpointId, false);
        }
      }
    });
  }

  // ##########################################################

  // Set State Node
  function alexaHomeState(n) {
    RED.nodes.createNode(this, n);
    this.conf = RED.nodes.getNode(n.conf);
    this.confId = n.conf;
    this.device = n.device;
    this.name = n.name;
    this.type = n.type;
    var nodeContext = this.context();
    var node = this;
    var onGoingCommands = {};

    // console.log('***** config.contextName: ' + JSON.stringify(node.conf.contextName));
    node.contextName = node.conf.contextName || "memory"; // set to 'memory' where config will be missing this on update for existing users

    // Timer to rate limit messages
    var timer = setInterval(function () {
      var now = Date.now();
      var keys = Object.keys(onGoingCommands);
      var key;
      nodeContext.set("tmpCommand", "", node.contextName);
      nodeContext.set("tmpKey", "", node.contextName);
      for (key in keys) {
        var stateUpdate = onGoingCommands[keys[key]];
        if (stateUpdate) {
          if (
            !nodeContext.get("tmpCommand", node.contextName) ||
            nodeContext.get("tmpCommand", node.contextName) == ""
          ) {
            // Capture first state update
            nodeContext.set(
              "tmpCommand",
              onGoingCommands[keys[key]],
              node.contextName
            );
            nodeContext.set("tmpKey", key, node.contextName);
          } else {
            // If newer command same as previous, delete previous
            //console.log("debug, Timer GET stateUpdate keys:" + Object.keys(stateUpdate.payload.state));
            //console.log("debug, Timer GET tmpCommand keys:" + Object.keys(nodeContext.get('tmpCommand',node.contextName).payload.state));

            // if (Object.keys(stateUpdate.payload.state).toString() == Object.keys(nodeContext.get('tmpCommand',node.contextName).payload.state).toString() && stateUpdate.messageId != nodeContext.get('tmpCommand',node.contextName).messageId) {
            if (
              Object.keys(stateUpdate.payload.state).toString() ==
              Object.keys(
                nodeContext.get("tmpCommand", node.contextName).payload.state
              ).toString()
            ) {
              node.log(
                "Timer throttled/ deleted state update: " +
                keys[nodeContext.get("tmpKey", node.contextName)]
              );
              delete onGoingCommands[
                keys[nodeContext.get("tmpKey", node.contextName)]
              ];
              nodeContext.set(
                "tmpCommand",
                onGoingCommands[keys[key]],
                node.contextName
              );
              nodeContext.set("tmpKey", key, node.contextName);
            } else {
              //console.log("debug, Timer No match of object keys");
              nodeContext.set(
                "tmpCommand",
                onGoingCommands[keys[key]],
                node.contextName
              );
              nodeContext.set("tmpKey", key, node.contextName);
            }
          }
          var diff = now - stateUpdate.timestamp;
          if (diff > 1000) {
            node.conf.updateState(
              stateUpdate.messageId,
              stateUpdate.endpointId,
              stateUpdate.payload,
              node.name
            );
            //console.log("debug, Timer sent state update: " + keys[key]);
            delete onGoingCommands[keys[key]];
          }
        }
      }
    }, 250); // 250 Millisecond Timer

    // Store timer Id in node content
    nodeContext.set("timer", timer, node.contextName);

    // Set State Node On Input Function
    node.on("input", function (msg) {
      // State update could be for any state(s), validate the state message falls within expected params
      var stateValid = true;
      var statelessCommand = false;
      // Handle AlexaHome output
      if (msg.command == "AdjustPercentage") {
        msg.payload = { state: { percentageDelta: msg.payload } };
      } else if (msg.command == "AdjustTargetTemperature") {
        msg.payload = { state: { targetSetpointDelta: msg.payload } };
      } else if (msg.command == "AdjustVolume") {
        msg.payload = { state: { volumeDelta: msg.payload } };
      } else if (msg.command == "AdjustRangeValue") {
        msg.payload = { state: { rangeValueDelta: msg.payload } };
      } else if (msg.command == "Lock") {
        msg.payload = { state: { lock: "LOCKED" } };
      } else if (msg.command == "SetBrightness") {
        msg.payload = { state: { brightness: msg.payload } };
      } else if (msg.command == "SetColor") {
        msg.payload = {
          state: {
            colorHue: msg.payload.hue,
            colorSaturation: msg.payload.saturation,
            colorBrightness: msg.payload.brightness,
          },
        };
      } else if (msg.command == "SetColorTemperature") {
        msg.payload = { state: { colorTemperature: msg.payload } };
      } else if (msg.command == "SelectInput") {
        msg.payload = { state: { input: msg.payload } };
      } else if (msg.command == "SetMode") {
        msg.payload = { state: { mode: msg.payload } };
      } else if (msg.command == "SetMute") {
        msg.payload = { state: { mute: msg.payload } };
      } else if (msg.command == "SetPercentage") {
        msg.payload = { state: { percentage: msg.payload } };
      } else if (msg.command == "SetRangeValue") {
        msg.payload = { state: { rangeValue: msg.payload } };
      } else if (msg.command == "SetTargetTemperature") {
        msg.payload = { state: { thermostatSetPoint: msg.payload } };
      } else if (msg.command == "SetThermostatMode") {
        msg.payload = { state: { thermostatMode: msg.payload } };
      } else if (msg.command == "SetVolume") {
        msg.payload = { state: { volume: msg.payload } };
      } else if (msg.command == "TurnOff" || msg.command == "TurnOn") {
        msg.payload = { state: { power: msg.payload } };
      } else if (msg.command == "Unlock") {
        msg.payload = { state: { lock: "UNLOCKED" } };
      } else {
        var arrayStatelessCommands = [
          "Play",
          "Resume",
          "Pause",
          "FastFoward",
          "Rewind",
          "Previous",
          "Next",
          "StartOver",
        ];
        if (arrayStatelessCommands.indexOf(msg.command) > -1) {
          node.log(
            node.name +
            " state node: 'stateless' command received, dropping message (expected for specific commands)."
          );
          statelessCommand = true;
        } else if (msg.command) {
          node.warn(
            node.name +
            " state node: message object includes unexpected or invalid msg.command, please remove this from payload: " +
            msg.command
          );
        }
      }

      // Add msg.acknowledge to message if not derived from an Alexa/ Google Home command
      if (msg.hasOwnProperty("command") == false) {
        msg.acknowledge = true;
      }

      // Adjusted to send state update after any Alexa/ Google Home command
      if (
        msg.hasOwnProperty("command") == false &&
        statelessCommand == false &&
        nodeContext.get("lastPayload", node.contextName) &&
        msg.payload.hasOwnProperty("state", node.contextName)
      ) {
        //console.log("debug, ON Message, lastpayload: " + JSON.stringify(nodeContext.get('lastPayload',node.contextName)));
        //console.log("debug, ON Message, msg.payload: " + JSON.stringify(msg.payload));

        // Duplicate Payload to last payload received, discard unless an adjustment payload which is likely to be duplicate
        if (
          JSON.stringify(nodeContext.get("lastPayload", node.contextName)) ==
          JSON.stringify(msg.payload) &&
          !(
            msg.payload.state.hasOwnProperty("percentageDelta") ||
            msg.payload.state.hasOwnProperty("targetSetpointDelta") ||
            msg.payload.state.hasOwnProperty("volumeDelta")
          )
        ) {
          nodeContext.set("duplicatePayload", true, node.contextName);
        }
        // Non-duplicate payload. send to Web API
        else {
          nodeContext.set("duplicatePayload", false, node.contextName);
          nodeContext.set("lastPayload", msg.payload, node.contextName);
        }
      } else {
        nodeContext.set("duplicatePayload", false, node.contextName);
        nodeContext.set("lastPayload", msg.payload, node.contextName);
      }

      // Set State Payload Handler
      if (
        statelessCommand == false &&
        msg.hasOwnProperty("payload") &&
        msg.payload.hasOwnProperty("state") &&
        msg.hasOwnProperty("acknowledge") &&
        nodeContext.get("duplicatePayload", node.contextName) == false
      ) {
        // Perform validation of device state payload, expects payload.state to contain as below
        //     "brightness": payload.state.brightness,
        //     "colorBrightness": payload.state.colorBrightness,
        //     "colorHue": payload.state.colorHue,
        //     "colorSaturation": payload.state.colorSaturation,
        //     "colorTemperature": payload.state.colorTemperature,
        //     "contact": payload.state.contact,
        //     "input": payload.state.input,
        //     "lock": payload.state.lock,
        //     "mode": payload.state.mode,
        //     "motion": payload.state.motion,
        //     "mute": payload.state.mute,
        //     "percentage": payload.state.percentage,
        //     "percentageDelta": payload.state.percentageDelta,
        //     "playback": payload.state.playback,
        //     "power": payload.state.power,
        //     "rangeValue": payload.state.rangeValue,
        //     "rangeValueDelta": payload.state.rangeValueDelta,
        //     "temperature": payload.state.temperature,
        //     "targetSetpointDelta": payload.state.targetSetpointDelta,
        //     "thermostatMode": payload.state.thermostatMode,
        //     "thermostatSetPoint" : payload.state.thermostatSetPoint
        //     "volume" : payload.state.thermostatSetPoint
        //     "volumeDelta" : payload.state.thermostatSetPoint

        // Brightness state, expect state to be a number in range of 0-100
        if (msg.payload.state.hasOwnProperty("brightness")) {
          if (
            typeof msg.payload.state.brightness != "number" &&
            (msg.payload.state.brightness < 0 ||
              msg.payload.state.brightness > 100)
          ) {
            stateValid = false;
          }
          //node.log(node.name + " state node: brightness command received")
          //node.log(node.name + " " + JSON.stringify(msg.payload));
        }

        // If *both* color and colorTemperature state sent, warn and do not send
        if (
          msg.payload.state.hasOwnProperty("colorHue") &&
          msg.payload.state.hasOwnProperty("colorSaturation") &&
          msg.payload.state.hasOwnProperty("colorBrightness") &&
          msg.payload.state.hasOwnProperty("colorTemperature")
        ) {
          node.warn(
            node.name +
            " state node: you cannot send combined 'colorTemperatrure' and 'color' state updates, send most recent update/ change only"
          );
          stateValid = false;
        }
        // Color state, expect state to include hue, saturation and brightness, in range of 0-360 for hue and 0-1 for saturation and brightness
        else if (
          msg.payload.state.hasOwnProperty("colorHue") &&
          msg.payload.state.hasOwnProperty("colorSaturation") &&
          msg.payload.state.hasOwnProperty("colorBrightness")
        ) {
          if (
            typeof msg.payload.state.colorHue != "number" &&
            typeof msg.payload.state.colorSaturation != "number" &&
            typeof msg.payload.state.colorBrightness != "number" &&
            msg.payload.state.colorHue < 0 &&
            msg.payload.state.colorHue > 360 &&
            msg.payload.state.colorSaturation < 0 &&
            msg.payload.state.colorSaturation > 1 &&
            msg.payload.state.colorBrightness < 0 &&
            msg.payload.state.colorBrightness > 1
          ) {
            stateValid = false;
          }
        }
        // Color Temperature, expect state to include colorTemperatureInKelvin, in range of 0-10000
        else if (msg.payload.state.hasOwnProperty("colorTemperature")) {
          if (
            typeof msg.payload.state.colorTemperature != "number" &&
            (msg.payload.state.colorTemperature < 0 ||
              msg.payload.state.colorTemperature > 10000)
          ) {
            stateValid = false;
          }
        }
        // Contact Sensor state, expect state to be a string
        if (msg.payload.state.hasOwnProperty("contact")) {
          if (
            typeof msg.payload.state.contact != "string" &&
            (msg.payload.state.contact != "DETECTED" ||
              msg.payload.state.contact != "NOT_DETECTED")
          ) {
            stateValid = false;
          }
        }
        // Input state, expect string, inputs will grow so no point in specific string checking
        if (msg.payload.state.hasOwnProperty("input")) {
          if (typeof msg.payload.state.input != "string") {
            stateValid = false;
          }
        }
        // Lock state, expect string, either LOCKED or UNLOCKED
        if (msg.payload.state.hasOwnProperty("lock")) {
          if (
            typeof msg.payload.state.lock != "string" &&
            (msg.payload.state.lock != "LOCKED" ||
              msg.payload.state.lock != "UNLOCKED")
          ) {
            stateValid = false;
          }
        }
        // Mode state, expect string, no point in specific string checking
        if (msg.payload.state.hasOwnProperty("mode")) {
          if (typeof msg.payload.state.mode != "string") {
            stateValid = false;
          }
        }
        // Motion Sensor state, expect state to be a string
        if (msg.payload.state.hasOwnProperty("motion")) {
          if (
            typeof msg.payload.state.motion != "string" &&
            (msg.payload.state.motion != "DETECTED" ||
              msg.payload.state.motion != "NOT_DETECTED")
          ) {
            stateValid = false;
          }
        }
        // Mute state, expect string, either ON or OFF
        if (msg.payload.state.hasOwnProperty("mute")) {
          if (
            typeof msg.payload.state.mute != "string" &&
            (msg.payload.state.mute != "ON" || msg.payload.state.mute != "OFF")
          ) {
            stateValid = false;
          } else {
            if (msg.payload.state.mute == "ON") {
              msg.payload.state.mute = true;
            } else if (msg.payload.state.mute == "OFF") {
              msg.payload.state.mute = false;
            }
          }
        }
        // Percentage state, expect state top be number between 0 and 100
        if (msg.payload.state.hasOwnProperty("percentage")) {
          if (
            typeof msg.payload.state.percentage != "number" &&
            (msg.payload.state.percentage < 0 ||
              msg.payload.state.percentage > 100)
          ) {
            stateValid = false;
          }
        }
        // PercentageDelta state, expect state top be number between 0 and 100
        if (msg.payload.state.hasOwnProperty("percentageDelta")) {
          if (
            typeof msg.payload.state.percentageDelta != "number" &&
            (msg.payload.state.percentageDelta < -100 ||
              msg.payload.state.percentageDelta > 100)
          ) {
            stateValid = false;
          }
        }
        // Power state, expect state to be string, either ON or OFF
        if (msg.payload.state.hasOwnProperty("power")) {
          if (
            typeof msg.payload.state.power != "string" &&
            (msg.payload.state.power != "ON" ||
              msg.payload.state.power != "OFF")
          ) {
            stateValid = false;
          }
        }
        // Range value, expect number
        if (msg.payload.state.hasOwnProperty("rangeValue")) {
          if (typeof msg.payload.state.rangeValue != "number") {
            stateValid = false;
          }
        }
        // Range value delta, expect number
        if (msg.payload.state.hasOwnProperty("rangeValueDelta")) {
          if (typeof msg.payload.state.rangeValueDelta != "number") {
            stateValid = false;
          }
        }
        // Temperature sensor state, expect state to be a number
        if (msg.payload.state.hasOwnProperty("temperature")) {
          if (typeof msg.payload.state.temperature != "number") {
            stateValid = false;
          }
        }
        // ThermostatMode state, expect state to be a number
        if (msg.payload.state.hasOwnProperty("thermostatMode")) {
          if (typeof msg.payload.state.thermostatMode != "string") {
            stateValid = false;
          }
        }
        // TargetSetpointDelta state, expect state to be a number
        if (msg.payload.state.hasOwnProperty("targetSetpointDelta")) {
          if (typeof msg.payload.state.targetSetpointDelta != "number") {
            stateValid = false;
          }
        }
        // ThermostatSetPoint state, expect state to be a number
        if (msg.payload.state.hasOwnProperty("thermostatSetPoint")) {
          if (typeof msg.payload.state.thermostatSetPoint != "number") {
            stateValid = false;
          }
        }
        // Volume state, expect state to be a number
        if (msg.payload.state.hasOwnProperty("volume")) {
          if (typeof msg.payload.state.volume != "number") {
            stateValid = false;
          }
        }
        // VolumeDelta state, expect state to be a number
        if (msg.payload.state.hasOwnProperty("volumeDelta")) {
          if (typeof msg.payload.state.volumeDelta != "number") {
            stateValid = false;
          }
        }
        if (stateValid && msg.acknowledge == true) {
          // Send messageId, deviceId, capability and payload to updateState
          var messageId = uuid();
          //node.conf.updateState(messageId, this.device, msg.payload);
          var command = {
            messageId: messageId,
            endpointId: this.device,
            payload: msg.payload,
            timestamp: Date.now(),
          };
          onGoingCommands[messageId] = command;
        } else if (stateValid && msg.acknowledge != true) {
          // Either auto-acknowledge is enabled on sender node, or validation has taken place
          node.warn(
            node.name +
            " state node: valid state update but msg.payload.acknowledge is false/ invalid/ missing"
          );
        } else {
          // State update not valid, logic above will explain why
          node.warn(
            node.name +
            " state node: msg.payload.state not valid, check data types (numbers are not strings etc.) / format of state element"
          );
        }
      }
      // Payload missing
      else if (statelessCommand == false && !msg.hasOwnProperty("payload")) {
        node.warn(node.name + " state node: msg.payload missing!");
      }
      // State missing
      else if (
        statelessCommand == false &&
        !msg.payload.hasOwnProperty("state")
      ) {
        node.warn(
          node.name + " state node: msg.payload missing state element!"
        );
      }
      // Acknowledge missing
      else if (
        statelessCommand == false &&
        !msg.hasOwnProperty("acknowledge")
      ) {
        node.warn(node.name + " state node: message missing msg.acknowledge");
      }
      // Duplicate State Update
      else if (nodeContext.get("duplicatePayload", node.contextName) == true) {
        // node.log(node.name + " state node: discarded duplicate state payload");
      }
    });

    if (node.conf) {
      node.conf.register(node);
    } else {
      node.warn("Unable to register state node, account not configured!");
    }

    node.on("close", function (done) {
      node.conf.deregister(node, done);
      clearInterval(nodeContext.get("timer", node.contextName)); // Close Interval Timer used node context stored Id
    });
  }

  // ##########################################################

  // Re-branded for v3 API
  RED.nodes.registerType("alexa-smart-home-v3-resp", alexaHomeResponse);

  // New Node Type for State Reporting to Web App
  RED.nodes.registerType("alexa-smart-home-v3-state", alexaHomeState);

  // Re-branded for v3 API
  RED.httpAdmin.use("/alexa-smart-home-v3/new-account", bodyParser.json());

  // Shouldn't need a change?
  // ## Changed to include url in expected params
  function getDevices(url, username, password, id) {
    if (url && username && password) {
      const options = {
        //ecdhCurve: 'auto',
        hostname: url,
        port: 443,
        path: "/api/v1/devices",
        method: "GET",
        auth: username + ":" + password,
      };

      const req = https.request(options, (res) => {
        //console.log('statusCode:', res.statusCode);
        //console.log('headers:', res.headers);
        var body = "";
        res.on("data", (d) => {
          if (res.statusCode == 200) {
            body = body + d;
          }
          // else {
          //     console.log("Error: getDevices status code: " + res.statusCode);
          //     console.log("Error: getDevices returned data: " + res.d);
          // }
        });

        res.on("end", (d) => {
          if (res.statusCode == 200) {
            var devs = JSON.parse(body);
            devices[id] = devs;
          } else {
            console.log("Error: getDevices status code: " + res.statusCode);
            console.log("Error: getDevices returned data: " + res.d);
          }
        });
      });

      req.on("error", (e) => {
        console.log(
          "Error: getDevices unable to lookup devices for username: " + username
        );
        console.log("Error: getDevices returned: " + e);
      });
      req.end();
    }
  }

  // UUID Generator
  function uuid() {
    var uuid = "",
      i,
      random;
    for (i = 0; i < 32; i++) {
      random = (Math.random() * 16) | 0;

      if (i == 8 || i == 12 || i == 16 || i == 20) {
        uuid += "-";
      }
      uuid += (i == 12 ? 4 : i == 16 ? (random & 3) | 8 : random).toString(16);
    }
    return uuid;
  }

  // Re-branded for v3 API
  RED.httpAdmin.post("/alexa-smart-home-v3/new-account", function (req, res) {
    //console.log("httpAdmin post", req.body);
    var username = req.body.user;
    var password = req.body.pass;
    var url = req.body.webapi;
    var id = req.body.id;
    // ## Modified
    getDevices(url, username, password, id);
  });

  // Re-branded for v3 API
  RED.httpAdmin.post("/alexa-smart-home-v3/refresh/:id", function (req, res) {
    var id = req.params.id;
    var conf = RED.nodes.getNode(id);
    if (conf) {
      var username = conf.credentials.username;
      var password = conf.credentials.password;
      var url = conf.webapiurl;
      getDevices(url, username, password, id);
      res.status(200).send();
    } else {
      //not deployed yet
      RED.warn("Can't refresh devices until deployed");
      res.status(404).send();
    }
  });

  // Re-branded for v3 API
  RED.httpAdmin.get("/alexa-smart-home-v3/devices/:id", function (req, res) {
    if (devices[req.params.id]) {
      res.send(devices[req.params.id]);
    } else {
      res.status(404).send();
    }
  });
};
