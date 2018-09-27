This node allows you to leverage the Alexa Node-RED Home Skill v3 API bridge, enabling Playback Control, Power Control, Input Control etc.*

|Alexa Interface|Supported Controls|Example Usage|Useful Links|
|--------|----------|-------------|-------------|
|Input Control|HDMI1,HDMI2,HDMI3,HDMI4,phono,audio1,audio2 and "chromecast"|Yamaha Music Cast Amplifier|[node-red-contrib-avr-yamaha](https://flows.nodered.org/node/node-red-contrib-avr-yamaha)|
|Playback Control|Play, Pause, Stop|Kodi RPC|Http Response Node with [Kodi RPC Commands](https://kodi.wiki/view/JSON-RPC_API/Examples)|
|Power Control|On, Off|MQTT Out|Any MQTT-enabled switch, Socket etc|
|Scene Control|Turn On|Multiple|String together a number of nodes for your scene, i.e. lighting, TV on, ACR on|
|Speaker (Step)|+/- volume|Yamaha Music Cast Amplifier|[node-red-contrib-avr-yamaha](https://flows.nodered.org/node/node-red-contrib-avr-yamaha)|
|Thermostats Control (Single setpoint only)|Set specific temp, increase/ decrease|Any MQTT connected thermostat/HVAC|-|

In order to use this node you will require an account with [this](https://nr-alexav3.cb-net.co.uk/) service. Once you have an account you can search for the Node-RED skill in the Alexa app and then link the account.

[See full documentation](https://nr-alexav3.cb-net.co.uk/docs) to get up and running..

## Installation
(This is not an NPM packaged version, for now, in order to avoid confusion with existing v2 API Home Skill):
```
mkdir node-red-contrib-alexa-home-skill
cd node-red-contrib-alexa-home-skill
git clone https://github.com/coldfire84/node-red-contrib-alexa-home-skill-v3.git
npm install
```