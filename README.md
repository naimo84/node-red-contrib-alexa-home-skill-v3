This node allows you to hook up Node-RED to react to your Amazon Echo.

By using the Home Skill pattern you can use commands like 

"Alexa, turn on the Kitchen Lights" and have this trigger a Node-RED flow.

In order to use this node you will require an account with 
[this](https://nr-alexav3.cb-net.co.uk/) service. Once you have 
an account you can search for the Node-RED skill in the Alexa app and then 
link the account.

[Full documentation](https://github.com/coldfire84/node-red-alexa-home-skill-v3-web/blob/master/README.md) to set up the service.

## Install
(NPM packaged version coming, for now):
```
mkdir node-red-contrib-alexa-home-skill
cd node-red-contrib-alexa-home-skill
git clone https://github.com/coldfire84/node-red-contrib-alexa-home-skill-v3.git
npm install
```