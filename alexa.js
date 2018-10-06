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

module.exports = function(RED) {
    "use strict";
    var request = require('request');
    var mqtt = require('mqtt');
    var bodyParser = require('body-parser');

    // Change these to match your hosting environment
    var webHost = "nr-alexav3.cb-net.co.uk";
    var mqttHost = "mq-alexav3.cb-net.co.uk";

    var devicesURL = "https://" + webHost + "/api/v1/devices";
    var devices = {};

    function alexaConf(n) {
    	RED.nodes.createNode(this,n);
    	this.username = n.username;
    	this.password = this.credentials.password;

        this.users = {};

    	var node = this;

        // Testing ONLY
        /*  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
        var options = {
            username: node.username,
            password: node.password,
            clientId: node.username,
            reconnectPeriod: 5000,
            servers:[{
                    protocol: 'mqtt',
                    host: mqttHost,
                    port: 1883
                }
            ]
        }; */

        // Production config
         var options = {
            username: node.username,
            password: node.password,
            clientId: node.username,
            reconnectPeriod: 5000,
            servers:[
                {
                    protocol: 'mqtts',
                    host: mqttHost,
                    port: 8883
                },
                {
                    protocol: 'mqtt',
                    host: mqttHost,
                    port: 1883
                }
            ]
        };

        getDevices(node.username, node.password, node.id);

        this.connect = function() {
            node.client = mqtt.connect(options);
            node.client.setMaxListeners(0);

            node.client.on('connect', function() {
                node.setStatus({text:'connected', shape:'dot', fill:'green'});
                node.client.removeAllListeners('message');
                node.client.subscribe("command/" + node.username + "/#");
                node.client.on('message', function(topic, message){
                    var msg = JSON.parse(message.toString());
                    //console.log("msg", msg)
                    var endpointId = msg.directive.endpoint.endpointId;
                    for (var id in node.users) {
                        if (node.users.hasOwnProperty(id)){
                            if (node.users[id].device === endpointId) {
                                node.users[id].command(msg);
                            }
                        }
                    }
                });
            });

            node.client.on('offline',function(){
                node.setStatus({text: 'disconnected', shape: 'dot', fill:'red'});
            });

            node.client.on('reconnect', function(){
                node.setStatus({text: 'reconnecting', shape: 'ring', fill:'red'});
            });

            node.client.on('error', function (err){
                //console.log(err);
                node.setStatus({text: 'disconnected', shape: 'dot', fill:'red'});
                node.error(err);
            });
        }

        this.setStatus = function(status) {
            for( var id in node.users) {
                if (node.users.hasOwnProperty(id)) {
                    node.users[id].status(status);
                }
            }
        }

        this.register = function(deviceNode) {
            node.users[deviceNode.id] = deviceNode;
            if (Object.keys(node.users).length === 1) {
                //connect
                node.connect();
            }
        };

        this.deregister = function(deviceNode, done) {
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

        this.acknowledge = function(messageId, device, success) {
            var response = {
                messageId: messageId,
                success: success
            };

            console.log("response: " + response);

            var topic = 'response/' + node.username + '/' + device;
            if (node.client && node.client.connected) {
                node.client.publish(topic, JSON.stringify(response));
            }
        };

        // ##########################################################
        // New function to report state, to be used on new node
        // Plan, node will receive state information via Standard MQTT out/ another output 
        // NodeJS WebApp is subscribed to state/#, so will intercept these messages
                // On change API will update 'lastKnownState' object on device
        // When Alexa queries/ requests state via Lambda web PI will check device state and return accordingly
        //
        // Need to be speciifc about deviceCapability and associated value, plus validate this. MongoDB property is as below:
                // lastknownState {
                    // BrightnessController
                    // ThermostatController
                    // PowerController
                    // StepSpeakerController
                    // PlaybackController
                    // InputController
                    // [..]
                //}

        this.updateState = function(messageId, endpointId, capability, payload) {
            var response = {
                messageId: messageId,
                capability: capability,
                payload: payload
            };
            console.log("State update: " + response);
            var topic = 'state/' + node.username + '/' + endpointId;
            if (node.client && node.client.connected) {
                node.client.publish(topic, JSON.stringify(response));
            }
        };
        // ##########################################################

    	this.on('close',function(){
            if (node.client && node.client.connected) {
                node.client.end();
            }
            //node.removeAllListeners();
    		//delete devices[node.id];
    	});
    };

    // Re-branded for v3 API
    RED.nodes.registerType("alexa-smart-home-v3-conf",alexaConf,{
        credentials: {
            password: {type:"password"}
        }
    });

    // Updated for v3 API
    function alexaHome(n) {
    	RED.nodes.createNode(this,n);
    	this.conf = RED.nodes.getNode(n.conf);
        this.confId = n.conf;
    	this.device = n.device;
        this.topic = n.topic;
        this.acknowledge = n.acknowledge;
        this.name = n.name;

    	var node = this;

        node.command = function (message){
            //console.log("message", message)
            var msg ={
                topic: node.topic || "",
                name: node.name,
                _messageId: message.directive.header.messageId,
                _endpointId: message.directive.endpoint.endpointId,
                _confId: node.confId,
                command: message.directive.header.name,
                extraInfo: message.directive.endpoint.cookie
            }

            var respond = true;

            // Needs expanding based on additional applications
            switch(message.directive.header.name){
                case "TurnOn":
                    // Power-on command
                    msg.payload = "ON";
                    break;
                case "TurnOff":
                    // Power-off command
                    msg.payload = "OFF";
                    break;
                case "AdjustVolume":
                    // Volume adjustment command
                    msg.payload = message.directive.payload.volumeSteps;
                    break;
                case "SetMute":
                    // Mute command
                    if (message.directive.payload.mute == false) {msg.payload = "OFF"};
                    if (message.directive.payload.mute == true) {msg.payload = "ON"};
                    break;
                case "SelectInput":
                    // Select input command
                    msg.payload = message.directive.payload.input;
                    break;
                case "SetTargetTemperature":
                    // Target temperature command
                    msg.payload = message.directive.payload.targetSetpoint.value;
                    msg.temperatureScale = message.directive.payload.targetSetpoint.scale;
                    break;
                case "SetBrightness":
                    // Brightness % command
                    msg.payload = message.directive.payload.brightness;
                    break;
                case "AdjustBrightness":
                    // Brightness % command
                    msg.payload = message.directive.payload.brightnessDelta;
                    break;
                case "SetColor":
                    // Color command
                    msg.payload = message.directive.payload.color;               
                    break;
                case "SetColorTemperature":
                    // Color command
                    msg.payload = message.directive.payload.colorTemperatureInKelvin;               
                    break;
                case "SetThermostatMode":
                    // Color command
                    msg.payload = message.directive.payload.thermostatMode.value;               
                    break;
                case "Lock":
                    // Color command
                    msg.payload = "Lock";               
                    break;
                case "Unlock":
                    // Color command
                    msg.payload = "Unlock";               
                    break;
            }
            
            node.send(msg);
            if (node.acknowledge && respond) {
                node.conf.acknowledge(message.directive.header.messageId, node.device, true);
            }
        }

        node.conf.register(node);

        node.on('close', function(done){
            node.conf.deregister(node, done);
        });

    }

   // Re-branded for v3 API
    RED.nodes.registerType("alexa-smart-home-v3", alexaHome);

    // Think this is OK for v3 API
    function alexaHomeResponse(n) {
        RED.nodes.createNode(this,n);

        var node = this;

        node.on('input',function(msg){
            if (msg._messageId && msg._endpointId && msg._confId) {
                var conf = RED.nodes.getNode(msg._confId);
                if (typeof msg.payload == 'boolean' && msg.payload) {
                    conf.acknowledge(msg._messageId, msg._endpointId, true);
                } else {
                    conf.acknowledge(msg._messageId, msg._endpointId, false);
                }
            }

        });
    }

    // ##########################################################

    // Think this is OK for v3 API
    function alexaHomeState(n) {
        RED.nodes.createNode(this,n);

    	this.conf = RED.nodes.getNode(n.conf);
        this.confId = n.conf;
    	this.device = n.device;
        this.name = n.name;

        var node = this;

        // On Input publish MQTT message to /state/<username>/<endpointId>
        node.on('input',function(msg){
            // Need to build device state here //

            // Requires "msg.capability" to be set to an aligned Alexa Smart Home Skill Controller
            // Expects msg.payload to be as outlined under switch/ case statements

            if (msg.capability) {              
                // Check msg.capability is valid, will pass this to WebAPI
                var deviceState;
                var capabilityValid = false;
                var stateValid = false;

                // Perform validation of Device Capability/ Payload
                switch(msg.capability){
                    case "BrightnessController": // Expects payload to contain brightness percentage, in range of 0-100
                        if (typeof msg.payload == 'number' && msg.payload >= 0 && msg.payload <= 100) {stateValid = true};
                        capabilityValid = true;
                        break;
                    case "ColorController":  // Expects payload to include hue, saturation and brightness, in range of 0-360 for hue and 0-1 for saturation and brightness
                        if (msg.payload.hasOwnProperty('hue') && msg.payload.hasOwnProperty('saturation') && msg.payload.hasOwnProperty('brightness')) {
                            if (msg.payload.hue >= 0 && msg.payload.hue <= 360 && msg.payload.saturation >= 0 
                                && msg.payload.saturation <= 1 && msg.payload.brightness >= 0 && msg.payload.brightness <= 1) {stateValid = true};
                        };
                        capabilityValid = true;
                        break;
                    case "ColorTemperatureController": // Expects payload to contain colorTemperatureInKelvin, in range of 0-10000
                        //update lastknownState.ColorTemperatureController
                        if (typeof msg.payload == 'number' && msg.payload >= 0 && msg.payload <= 10000) {stateValid = true};
                        capabilityValid = true;
                        break;
                    case "InputController": // Expects payload to be string, inputs will grow so no point in specific string checking
                        if (typeof msg.payload == 'string') {stateValid = true};
                        capabilityValid = true;
                        break;
                    case "LockController": // Expects payload to be string, either LOCKED or UNLOCKED
                        if (typeof msg.payload == 'string') {
                            if (msg.payload == "LOCKED" || msg.payload == "UNLOCKED") {stateValid = true};
                        };
                        capabilityValid = true;
                        break;
                    case "PlaybackController": // Expects payload to be string
                        if (typeof msg.payload == 'string') {stateValid = true};
                        capabilityValid = true;
                        break;
                    case "PowerController": // Expects payload to be string, either ON or OFF
                        if (typeof msg.payload == 'string') {
                            if (msg.payload == "ON" || msg.payload == "OFF") {stateValid = true};
                        };
                        capabilityValid = true;
                        break;
                    case "SceneController": // Expects payload to be string, either ON or OFF
                        if (typeof msg.payload == 'string') {
                            if (msg.payload == "ON" || msg.payload == "OFF") {stateValid = true};
                        };
                        capabilityValid = true;
                        break;
                    case "StepSpeakerController": // Can't return status on somehting that is unknown
                        capabilityValid = false;
                        break;
                    case "ThermostatController":// Expects payload to contain temperature and string, temperature is number, state is string
                        if (msg.payload.hasOwnProperty(temperature) && msg.payload.hasOwnProperty(mode)) {
                            if (typeof msg.payload.temperature == 'number' && msg.payload.mode == 'string') {stateValid = true};
                            capabilityValid = true;
                        }
                        break;
                }
            
                var conf = RED.nodes.getNode(msg._confId);
                if (capabilityValid && stateValid) {
                    // Send messageId, deviceId, capability and payload to updateState
                    var messageId = uuid();
                    conf.updateState(messageId, this.device, msg.capability, msg.payload);
                }
                else if (!capabilityValid) {console.log("Invalid capability, check msg.capability")}
                else if (!stateValid) {console.log("Valid capability but state invalid, check msg.payload")}
            }

            node.conf.register(node);

            node.on('close', function(done){
                node.conf.deregister(node, done);
            });

        });
    }
    
    // ##########################################################

    // Re-branded for v3 API
    RED.nodes.registerType("alexa-smart-home-v3-resp", alexaHomeResponse);

    // New Node Type for State Reporting to Web App
    RED.nodes.registerType("alexa-smart-home-v3-state", alexaHomeState);

    // Re-branded for v3 API
    RED.httpAdmin.use('/alexa-smart-home-v3/new-account',bodyParser.json());

    // Shouldn't need a change?
    function getDevices(username, password, id){
        if (username && password) {
            request.get({
                url: devicesURL,
                auth: {
                    username: username,
                    password: password
                }
            }, function(err, res, body){
                if (!err && res.statusCode == 200) {
                    var devs = JSON.parse(body);
                    //console.log(devs);
                    devices[id] = devs;
                } else {
                    //console.("err: " + err);
                    RED.log.log("Problem looking up " + username + "'s devices");
                }
            });
        }
    };

    // UUID Generator
    function uuid() {
        var uuid = "", i, random;
        for (i = 0; i < 32; i++) {
          random = Math.random() * 16 | 0;
      
          if (i == 8 || i == 12 || i == 16 || i == 20) {
            uuid += "-"
          }
          uuid += (i == 12 ? 4 : (i == 16 ? (random & 3 | 8) : random)).toString(16);
        }
        return uuid;
      }

    // Re-branded for v3 API
    RED.httpAdmin.post('/alexa-smart-home-v3/new-account',function(req,res){
    	//console.log(req.body);
    	var username = req.body.user;
    	var password = req.body.pass;
    	var id = req.body.id;
    	getDevices(username,password,id);
    });

    // Re-branded for v3 API
    RED.httpAdmin.post('/alexa-smart-home-v3/refresh/:id',function(req,res){
        var id = req.params.id;
        var conf = RED.nodes.getNode(id);
        if (conf) {
            var username = conf.username;
            var password = conf.credentials.password;
            getDevices(username,password,id);
            res.status(200).send();
        } else {
            //not deployed yet
            console.log("Can't refresh until deployed");
            res.status(404).send();
        }
    });

    // Re-branded for v3 API
    RED.httpAdmin.get('/alexa-smart-home-v3/devices/:id',function(req,res){
    	if (devices[req.params.id]) {
    		res.send(devices[req.params.id]);
    	} else {
    		res.status(404).send();
    	}
    });


};

