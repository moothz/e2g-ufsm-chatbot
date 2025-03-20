const TelegramBot = require('node-telegram-bot-api');
const fs = require('node:fs/promises');

class TelegramIntegration {
  constructor(token) {
    this.bot = new TelegramBot(token, { polling: true });
    this.token = token;

    this.bot.on('polling_error', (error) => {
      console.log("Telegram Polling Error:", error);
    });

    this.bot.on('callback_query', (callbackQuery) => {
      const message = {
        messageID: callbackQuery.message.message_id,
        userID: callbackQuery.from.id,
        message: callbackQuery.data, // Use callback_data as message
        media: null,
        source: 'telegram',
        location: null,
        sticker: null,
        originalMessage: callbackQuery.message
      };
      console.log("Received callback query:", callbackQuery); // Log the callback query
      this.messageCallback(message, callbackQuery.message); // Pass the message object
    });
  }

  onMessage(callback) {
    this.messageCallback = callback; // Store the callback

    this.bot.on('message', (msg) => {
      const message = {
        messageID: msg.message_id,
        userID: msg.from.id,
        message: msg.text || "",
        media: null,
        source: 'telegram',
        location: null,
        sticker: null,
        originalMessage: msg
      };

      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        this.bot.getFile(photo.file_id).then(fileInfo => {
          const photoUrl = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
          message.media = `photo:${photoUrl}`;
          callback(message, msg); // Pass the message object
        }).catch(err => {
          console.error("Error getting file info:", err);
          callback(message, msg); // Pass the message object
        });
      } else if (msg.location) {
        message.location = {
          latitude: msg.location.latitude,
          longitude: msg.location.longitude
        };
        callback(message, msg); // Pass the message object
      } else if (msg.sticker) {
          message.sticker = msg.sticker.file_id;
          callback(message, msg);
      } else {
        callback(message, msg); // Pass the message object
      }
    });
  }

  async sendMessage(outputMessage) {
    const { userID, message, options, messageID, step } = outputMessage;
    const shouldReply = step ? step.reply !== false : true; // Default to true if step or step.reply is undefined

    if (options) {
      const replyMarkup = {
        inline_keyboard: options.map(option => [
          { text: option.text, callback_data: option.value }
        ])
      };
      await this.bot.sendMessage(userID, message, { reply_markup: replyMarkup, ...(shouldReply && { reply_to_message_id: messageID }) })
        .then(result => {
          //console.log("Telegram API Response:", result); // Log the API response
        })
        .catch(error => {
          console.error("Telegram API Error:", error); // Log any API errors
        });
    } else {
      await this.bot.sendMessage(userID, message, { ...(shouldReply && { reply_to_message_id: messageID }) })
        .then(result => {
          //console.log("Telegram API Response:", result); // Log the API response
        })
        .catch(error => {
          console.error("Telegram API Error:", error); // Log any API errors
        });
    }
  }

  async sendPhoto(userID, imagePath, caption, options) {
    try {
      const fileContent = await fs.readFile(imagePath);
      await this.bot.sendPhoto(userID, fileContent, { caption: caption });

      // If options are provided, send a separate message with the inline keyboard
      if (options) {
         const replyMarkup = {
              inline_keyboard: options.map(option => [
                  { text: option.text, callback_data: option.value }
              ])
          };
          await this.bot.sendMessage(userID, caption, { reply_markup: replyMarkup });
      }
    } catch (error) {
      console.error("Error sending photo:", error);
      this.bot.sendMessage(userID, "Failed to send image. Here's the message instead: " + caption);
    }
  }

    async sendSticker(userID, stickerPath) {
        try {
            const fileContent = await fs.readFile(stickerPath);
            await this.bot.sendSticker(userID, fileContent);
        } catch (error) {
            console.error("Error sending sticker:", error);
            this.bot.sendMessage(userID, "Failed to send sticker.");
        }
    }
}

module.exports = TelegramIntegration;
