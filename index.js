require('dotenv').config();
const { loadJSON, saveJSON, generateUserId } = require('./utils');
const TelegramIntegration = require('./telegram');
const WhatsAppIntegration = require('./whatsapp');
const { makeFlowchart } = require('./flowchart');
const flow = loadJSON('flow.json');
let users = loadJSON('users.json');
let sessions = loadJSON('sessions.json');
const fs = require('node:fs/promises');
const fetch = require('node-fetch');
const path = require('path');
const Jimp = require('jimp');
const jsQR = require('jsqr');

const SESSION_TIMEOUT = process.env.SESSION_TIMEOUT;
const VERBOSE = process.env.VERBOSE === 'true';

// Initialize Telegram bot
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramIntegration = new TelegramIntegration(telegramToken);
telegramIntegration.onMessage(handleIncomingMessage);

// Initialize WhatsApp integration
const whatsappPhoneNumber = process.env.WHATSAPP_NUMBER;
const whatsappIntegration = new WhatsAppIntegration(whatsappPhoneNumber);
whatsappIntegration.onMessage(handleIncomingMessage);

async function handleIncomingMessage(message, messageObject) {
  if (VERBOSE) {
    console.log(`Mensagem recebida de ${message.source} usuário ${message.userID}: ${message.message}`);
  }

  let session = sessions[message.userID];
  let isInitialMessage = !message.message && !message.media && !message.location && !message.sticker;

  if (!session) {
    const user = users.find(u => u.messengers.some(m => m.source === message.source && m.id === message.userID));
    if (!user) {
      session = startSession(message.userID, "register_name", message.source);
      if (VERBOSE) {
        console.log(`Nova sessão iniciada para ${message.source} usuário ${message.userID}. Passo inicial: register_name`);
      }
    } else {
      session = startSession(message.userID, "main_menu", message.source);
      session.userID = user.userID;
      if (VERBOSE) {
        console.log(`Usuário existente ${user.userID} logado de ${message.source}. Sessão iniciada em main_menu`);
      }
    }
  }

  // Send initial message if it's a new session or user just logged in
  if (!session.initialMessageSent) {
    const currentStep = flow.find(step => step.step === session.currentStep);
    sendInitialMessage(session, message, {}, currentStep);
    session.initialMessageSent = true;
    saveSessions();
    return;
  }

  if (Date.now() - session.lastActivity > SESSION_TIMEOUT) {
    await sendMessage({
      userID: message.userID,
      messageID: message.messageID,
      message: "Sua sessão expirou. Por favor, comece novamente.",
      source: message.source,
      step: { reply: false }
    });
    delete sessions[message.userID];
    session = startSession(message.userID, "main_menu", message.source);
    const currentStep = flow.find(step => step.step === session.currentStep);
    sendInitialMessage(session, message, {}, currentStep);
    session.initialMessageSent = true;
    saveSessions();
    return;
  }

  session.lastActivity = Date.now();

  if (message.message === "cancel") {
    await sendMessage({
      userID: message.userID,
      messageID: message.messageID,
      message: "Retornando ao início.",
      source: message.source,
      step: { reply: false }
    });
    session.currentStep = "main_menu";
    session.retries = 0;
    session.initialMessageSent = false;
    const currentStep = flow.find(step => step.step === session.currentStep);
    sendInitialMessage(session, message, {}, currentStep);
    saveSessions();
    return;
  }

  await handleFlowStep(session, message);
}

async function handleFlowStep(session, message) {
  const currentStep = flow.find((step) => step.step === session.currentStep);

  if (!currentStep) {
    console.error("Passo de fluxo inválido:", session.currentStep);
    return;
  }

  if (VERBOSE) {
    console.log(`Passo atual para o usuário ${session.userID}: ${currentStep.step}`);
  }

  let isInitialMessage = !message.message && !message.media && !message.location && !message.sticker;
  let optinResult = session.optinResult || {};
  delete session.optinResult;

  if (currentStep.input && !isInitialMessage) {
    if (!validateInput(message, currentStep.input)) {
      session.retries = (session.retries || 0) + 1;
      const maxRetries = currentStep.retries || 3;

      if (session.retries >= maxRetries) {
        await sendMessage({
          userID: message.userID,
          messageID: message.messageID,
          message: "Muitas tentativas incorretas. Retornando ao início.",
          source: message.source,
          step: { reply: false }
        });
        session.currentStep = "main_menu";
        session.retries = 0;
        session.initialMessageSent = false;
        if (VERBOSE) {
          console.log(`Muitas tentativas incorretas para o usuário ${session.userID}. Sessão reiniciada para main_menu`);
        }
      } else {
        // Check for custom error message
        if (currentStep.custom_error_message !== undefined && currentStep.custom_error_message !== false) {
          let errorMessage = currentStep.custom_error_message;
          errorMessage = errorMessage.replace('{currentRetries}', session.retries);
          errorMessage = errorMessage.replace('{maxRetries}', maxRetries);

          await sendMessage({
            userID: message.userID,
            messageID: message.messageID,
            message: errorMessage,
            source: message.source,
            step: currentStep
          });
          if (VERBOSE) {
            console.log(`Entrada inválida para o usuário ${session.userID} no passo ${currentStep.step}. Tentativa ${session.retries}. Mensagem customizada enviada.`);
          }
        } else {
          // Optional:  You could have a default error message here if you *do* want a message
          // when custom_error_message is undefined, but the requirements say not to.
        }
      }
      saveSessions();
      return;
    }
    session.retries = 0;
    if (currentStep.input !== "location" && currentStep.input !== "sticker") {
      session.userData[currentStep.step] = message.message;
    } else if (currentStep.input === "location") {
      session.userData[currentStep.step] = message.location;
    } else if (currentStep.input === "sticker") {
      session.userData[currentStep.step] = message.sticker;
    }
    if (VERBOSE) {
      console.log(`Entrada recebida para o usuário ${session.userID} no passo ${currentStep.step}: ${message.message || JSON.stringify(message.location) || message.sticker}`);
    }
  }

  if (currentStep.step.startsWith("register")) {
    if (!isInitialMessage) {
      await handleRegistration(session, message, currentStep);
    }
  } else {
    let nextStepKey = currentStep.next;

    if (currentStep.optin && !isInitialMessage) {
      const inputValues = {};
      for (const inputStepId of currentStep.optin.inputs) {
        inputValues[inputStepId] = session.userData[inputStepId];
      }
      optinResult = handleOptin(currentStep.optin.method, inputValues);
      session.optinResult = optinResult;
      if (VERBOSE) {
        console.log(`Método optin ${currentStep.optin.method} chamado para o usuário ${session.userID}. Resultado: ${JSON.stringify(optinResult)}`);
      }
    }

    if (typeof nextStepKey === 'object') {
      if (currentStep.input === "menu" && !isInitialMessage) {
        const selectedOptionIndex = parseInt(message.message, 10) - 1;
        if (message.source === 'whatsapp' && !isNaN(selectedOptionIndex) && selectedOptionIndex >= 0 && selectedOptionIndex < currentStep.options.length) {
          const selectedOption = currentStep.options[selectedOptionIndex];
          nextStepKey = currentStep.next[selectedOption.value];
        }
        else {
          const selectedOption = currentStep.options.find(opt => opt.value === message.message);
          if (selectedOption) {
            nextStepKey = currentStep.next[selectedOption.value];
          } else {
            console.error("Seleção de menu inválida");
            return;
          }
        }
      } else {
        if (!isInitialMessage) {
          nextStepKey = currentStep.next[message.message] || currentStep.next;
        }
      }
    }

    const nextStep = flow.find(s => s.step === nextStepKey);

    if (nextStep) {
      session.currentStep = nextStep.step;
      session.initialMessageSent = false;
      if (VERBOSE) {
        console.log(`Próximo passo para o usuário ${session.userID}: ${nextStep.step}`);
      }

      sendInitialMessage(session, message, optinResult, nextStep);
      session.initialMessageSent = true;

      if (!nextStep.input) {
        await handleFlowStep(session, message);
        return;
      }
    } else if (Object.keys(optinResult).length > 0 && !isInitialMessage) {
      let messageText = "";
      for (const key in optinResult) {
        messageText += `${key}: ${optinResult[key]}\n`;
      }
      await sendMessage({
        userID: message.userID,
        messageID: message.messageID,
        message: messageText.trim(),
        source: message.source,
        step: currentStep,
      });
      if (VERBOSE) {
        console.log(`Resultado do optin enviado para o usuário ${session.userID}: ${messageText.trim()}`);
      }
      session.currentStep = "main_menu";
      session.initialMessageSent = false;
      const nextCurrentStep = flow.find(step => step.step === session.currentStep);
      sendInitialMessage(session, message, {}, nextCurrentStep);
    }
  }

  if (message.media && !isInitialMessage) {
    await handleMedia(message);
  }

  saveSessions();
}

async function handleRegistration(session, message, currentStep) {
  let user = users.find(u => u.userID === message.userID);

  if (currentStep.step === "register_name") {
    session.userData = { name: message.message };
    session.currentStep = "register_cpf";
    session.initialMessageSent = false;
    await sendMessage({
      userID: message.userID,
      messageID: message.messageID,
      message: currentStep.next ? flow.find(s => s.step === currentStep.next).message : "Próxima mensagem da etapa",
      source: message.source,
      step: currentStep,
    });
    if (VERBOSE) {
      console.log(`Usuário ${session.userID} inseriu o nome: ${message.message}. Prosseguindo para register_cpf`);
    }
  } else if (currentStep.step === "register_cpf") {
    const cpf = message.message.replace(/\D/g, '');
    if (cpf.length !== 11) {
      await sendMessage({
        userID: message.userID,
        messageID: message.messageID,
        message: "CPF inválido. Por favor, insira um CPF válido de 11 dígitos.",
        source: message.source,
        step: currentStep,
      });
      if (VERBOSE) {
        console.log(`CPF inválido inserido pelo usuário ${session.userID}: ${message.message}`);
      }
      return;
    }

    let existingUser = users.find(u => u.cpf === cpf);
    if (existingUser) {
      const messenger = { source: message.source, id: message.userID };
      if (!existingUser.messengers.find(m => m.source === messenger.source && m.id === messenger.id)) {
        existingUser.messengers.push(messenger);
        if (VERBOSE) {
          console.log(`Mensageiro ${message.source} adicionado ao usuário existente ${existingUser.userID}`);
        }
      }
      await sendMessage({
        userID: message.userID,
        messageID: message.messageID,
        message: `Bem-vindo de volta, ${existingUser.name}! Sua conta foi atualizada.`,
        source: message.source,
        step: currentStep,
      });
      session.currentStep = "main_menu";
      session.initialMessageSent = false;
      session.userID = existingUser.userID;
      users = users.map(u => u.userID === existingUser.userID ? existingUser : u);
      saveUsers();
      if (VERBOSE) {
        console.log(`Usuário existente ${existingUser.userID} logado. Sessão definida para main_menu`);
      }

      const nextCurrentStep = flow.find(step => step.step === session.currentStep);
      sendInitialMessage(session, message, {}, nextCurrentStep);
    } else {
      const newUser = {
        userID: generateUserId(),
        name: session.userData.name,
        cpf: cpf,
        messengers: [{ source: message.source, id: message.userID }],
      };
      users.push(newUser);
      await sendMessage({
        userID: message.userID,
        messageID: message.messageID,
        message: `Cadastro concluído! Bem-vindo, ${newUser.name}!`,
        source: message.source,
        step: currentStep,
      });
      session.currentStep = "main_menu";
      session.initialMessageSent = false;
      session.userID = newUser.userID;
      saveUsers();
      if (VERBOSE) {
        console.log(`Novo usuário registrado: ${newUser.userID}. Sessão definida para main_menu`);
      }
      const nextCurrentStep = flow.find(step => step.step === session.currentStep);
      sendInitialMessage(session, message, {}, nextCurrentStep);
    }
  }
}

function validateInput(message, inputType) {
  switch (inputType) {
    case "text":
      return typeof message.message === "string" && message.message.trim() !== "";
    case "number":
      return !isNaN(parseInt(message.message));
    case "image":
      return !!message.media;
    case "sticker":
      return !!message.sticker;
    case "menu":
      const currentStep = flow.find((step) => step.step === sessions[message.userID].currentStep);
      if (message.source === 'whatsapp') {
        const selectedOptionIndex = parseInt(message.message, 10) - 1;
        return !isNaN(selectedOptionIndex) && selectedOptionIndex >= 0 && selectedOptionIndex < currentStep.options.length;
      }
      return currentStep.options.some(opt => opt.value === message.message);
    case "location":
      return !!message.location;
    default:
      return true;
  }
}

function startSession(userID, initialStep, source) {
  const session = {
    userID,
    currentStep: initialStep,
    lastActivity: Date.now(),
    retries: 0,
    userData: {},
    source: source,
    initialMessageSent: false,
  };
  sessions[userID] = session;
  saveSessions();
  return session;
}

async function handleMedia(message) {
  const tempDir = path.join(__dirname, 'temp');

  try {
    // Ensure 'temp' directory exists
    try {
      await fs.mkdir(tempDir);
    } catch (error) {
      if (error.code !== 'EEXIST') { // Ignore if the directory already exists
        throw error; // Re-throw other errors
      }
    }

    if (message.source === 'telegram' && message.media) {
      let file_id;

      if (message.originalMessage && message.originalMessage.photo) {
        const photos = message.originalMessage.photo;
        file_id = photos[photos.length - 1].file_id;
      } else {
        console.log("No photo found in the message.");
        return;
      }

      const fileInfo = await telegramIntegration.bot.getFile(file_id);
      const photoUrl = `https://api.telegram.org/file/bot${telegramIntegration.token}/${fileInfo.file_path}`;

      const response = await fetch(photoUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      const buffer = await response.buffer();

      // Save to temp folder for debugging
      const fileExtension = path.extname(fileInfo.file_path);
      const tempFileName = `${Math.floor(Math.random() * 100000)}-${Date.now()}${fileExtension}`;
      const tempFilePath = path.join(tempDir, tempFileName);
      await fs.writeFile(tempFilePath, buffer);
      console.log(`Telegram media saved to: ${tempFilePath}`);

      // QR Code reading using jimp and jsqr
      const image = await Jimp.read(buffer);
      const qrCodeData = jsQR(image.bitmap.data, image.bitmap.width, image.bitmap.height);

      if (qrCodeData) {
        console.log("QR Code detected:", qrCodeData.data);
        handleQRCode(message, qrCodeData.data);
      } else {
        console.log("No QR Code detected in the image.");
      }

    } else if (message.source === 'whatsapp' && message.media) {
        // WhatsApp media handling
        const buff = Buffer.from(message.media, 'base64');
        const fileExtension = '.jpg'; // You might want to determine this dynamically
        const tempFileName = `${Math.floor(Math.random() * 100000)}-${Date.now()}${fileExtension}`;
        const tempFilePath = path.join(tempDir, tempFileName);

        await fs.writeFile(tempFilePath, buff);
        console.log(`WhatsApp media saved to: ${tempFilePath}`);
    }

  } catch (error) {
    console.error("Error handling media:", error);
    await sendMessage({
      userID: message.userID,
      messageID: message.messageID,
      message: "Erro ao processar a mídia.",
      source: message.source
    });
  }
}

function handleQRCode(message, qrCodeData) {
  sendMessage({
    userID: message.userID,
    messageID: message.messageID,
    message: `QR Code detectado: ${qrCodeData}`,
    source: message.source
  });
  if (VERBOSE) {
    console.log(`QR code detectado para o usuário ${message.userID}: ${qrCodeData}`);
  }
}

async function sendMessage(outputMessage) {
  if (outputMessage.source === 'telegram') {
    await telegramIntegration.sendMessage(outputMessage);
  } else if (outputMessage.source === 'whatsapp') {
    await whatsappIntegration.sendMessage(outputMessage);
  } else {
    console.warn(`Fonte de mensagem desconhecida: ${outputMessage.source}. Enviando através do Telegram.`);
    await telegramIntegration.sendMessage(outputMessage);
  }
}

function sendImageMessage(source, userID, caption, imagePath, options) {
  const fullImagePath = `${imagePath}`;
  if (source === 'telegram') {
    telegramIntegration.sendPhoto(userID, fullImagePath, caption, options);
  } else if (source === 'whatsapp') {
    whatsappIntegration.sendMedia(userID, fullImagePath, caption, options);
  } else {
    console.warn(`Fonte de mensagem desconhecida: ${source}. Não é possível enviar imagem.`);
  }
}

function sendStickerMessage(source, userID, stickerPath) {
  const fullStickerPath = `${stickerPath}`;
  if (source === 'telegram') {
    telegramIntegration.sendSticker(userID, fullStickerPath);
  } else if (source === 'whatsapp') {
    whatsappIntegration.sendSticker(userID, fullStickerPath);
  } else {
    console.warn(`Fonte de mensagem desconhecida: ${source}. Não é possível enviar sticker.`);
  }
}

function saveUsers() {
  saveJSON('users.json', users);
}

function saveSessions() {
  saveJSON('sessions.json', sessions);
}

function handleOptin(methodName, inputs) {
  switch (methodName) {
    case 'calculateSum':
      const num = parseInt(inputs[Object.keys(inputs)[0]]);
      return { sum_result: num + 10 };
    case 'greetUser':
      const text = inputs[Object.keys(inputs)[0]];
      return { greeting: `Olá, você digitou: ${text}` };
    case 'validateCPF':
      const cpf = inputs[Object.keys(inputs)[0]];
      const isAllSameDigit = /^(\d)\1+$/.test(cpf);
      return { cpf_validation_result: isAllSameDigit ? "CPF inválido (todos os dígitos são iguais)" : "CPF válido" }
    default:
      console.warn(`Método optin desconhecido: ${methodName}`);
      return {};
  }
}

makeFlowchart(flow);

function sendInitialMessage(session, message, optinResult = {}, step = null) {
  const currentStep = step;
  if (currentStep) {
    let messageText = currentStep.message;
    messageText = messageText.replace('{name}', users.find(u => u.userID === session.userID)?.name || "Usuário");

    for (const key in optinResult) {
      messageText = messageText.replace(`{${key}}`, optinResult[key]);
    }

    if (currentStep.image) {
      sendImageMessage(message.source, message.userID, messageText, currentStep.image, currentStep.input === 'menu' ? currentStep.options : null);
    } else if (currentStep.input === 'sticker') {
      sendStickerMessage(message.source, message.userID, currentStep.sticker);
    } else {
      sendMessage({
        userID: message.userID,
        messageID: message.messageID,
        message: messageText,
        source: message.source,
        options: currentStep.input === 'menu' ? currentStep.options : null,
        step: currentStep,
      });
    }
  }
}
