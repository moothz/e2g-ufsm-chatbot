const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const whitelist = ["555596792072@c.us"];

// Helper function to generate numbered menu options for WhatsApp
function generateWhatsAppMenuText(options) {
    let menuText = "\n";
    options.forEach((option, index) => {
        menuText += `${index + 1}. ${option.text}\n`;
    });
    return menuText;
}

class WhatsAppIntegration {
    constructor(phoneNumber) {
        this.phoneNumber = phoneNumber;
        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: "e2g-ufsm" }),
            puppeteer: {
                args: ['--no-sandbox'],
                headless: true
            },
        });

        this.client.on('qr', async (qr) => {
            console.log('QR RECEIVED');
            qrcode.generate(qr, {small: true});
            //const pairingCode = await this.client.requestPairingCode(phoneNumber);
            //console.log(`Pairing code for ${phoneNumber}: ${pairingCode}`);
        });

        this.client.on('authenticated', () => {
            console.log('WhatsApp client authenticated');
        });

        this.client.on('ready', () => {
            console.log('WhatsApp client is ready!');
        });

        this.client.initialize();
    }

    onMessage(callback) {
        this.client.on('message', async msg => {
            if(msg.from.includes("@g")){
                // Ignora mensagens em grupo
                return;
            }
            if(whitelist.length > 0){
                if(!whitelist.includes(msg.from)){
                    console.log(`[whatsapp] Ignorando mensagem de '${msg.from}'`);
                }
            }
            const message = {
                messageID: msg.id.id,
                userID: msg.from,
                message: msg.body,
                media: null,
                source: 'whatsapp',
                location: null,
                messageObject: msg,
                sticker: null,
            };

            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    if (msg.type === 'sticker') {
                        message.sticker = media.data;
                    } else {
                        message.media = media.data;
                    }
                } catch (error) {
                    console.error("Failed to download media:", error);
                }
            }
            if (msg.type === 'location') {
                message.location = {
                    latitude: msg.location.latitude,
                    longitude: msg.location.longitude
                };
            }

            callback(message);
        });
    }

    async sendMessage(outputMessage) {
        const { userID, message, messageID, step, messageObject, options } = outputMessage;
        const shouldReply = step ? step.reply !== false : true;

        let messageToSend = message;

        // WhatsApp Menu Handling
        if (options && options.length > 0) {
            messageToSend += generateWhatsAppMenuText(options); // Use the helper function
        }

        try {
            if (shouldReply) {
                if (messageObject) {
                    await messageObject.reply(messageToSend);
                } else {
                    await this.client.sendMessage(userID, messageToSend);
                }
            } else {
                await this.client.sendMessage(userID, messageToSend);
            }
        } catch (error) {
            console.error("Error sending WhatsApp message:", error);
        }
    }

    async sendMedia(contactId, filePath, caption, options) {
        try {
            let fullCaption = caption;
            if (options && options.length > 0) {
                fullCaption += generateWhatsAppMenuText(options); // Use helper function for menu
            }
            const media = MessageMedia.fromFilePath(filePath);
            await this.client.sendMessage(contactId, media, { caption: fullCaption });
        } catch (error) {
            console.error('Error sending media:', error);
            this.client.sendMessage(contactId, "Failed to send image. Here's the message instead: " + caption);
        }
    }

    async sendSticker(contactId, filePath) {
        try {
            const media = MessageMedia.fromFilePath(filePath);
						opts = {sendMediaAsSticker: true,stickerAuthor: `e2g-ufsm`,stickerName: "e2g-ufsm"};
            await this.client.sendMessage(contactId, media, opts);
        } catch (error) {
            console.error('Error sending sticker:', error);
            this.client.sendMessage(contactId, "Failed to send sticker.");
        }
    }
}

module.exports = WhatsAppIntegration;
