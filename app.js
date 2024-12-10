require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const fs = require('fs');
const path = require('path');
const qs = require("qs");
const OpenAI = require('openai');
const { urlencoded, json } = require("body-parser");
const MongoClient = require('mongodb').MongoClient;

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(urlencoded({ extended: true }));
app.use(json());
app.set('trust proxy', true);
app.use(express.raw({ type: '*/*' }));

// Configuration
const MONGO_URI = process.env.MONGO_URI;
const DATABASE_NAME = process.env.DATABASE_NAME || "session-manager-loreal-jp";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "loreal-jp";

const LINE_CONFIG = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const EVA_CONFIG = {
  apiKey: process.env.EVA_API_KEY,
  orgUuid: process.env.EVA_ORG_UUID,
  envUuid: process.env.EVA_ENV_UUID,
  botKey: process.env.EVA_BOT_KEY,
  channel: process.env.EVA_CHANNEL || "LINE2",
  evaBroker: process.env.EVA_BROKER_URL,
};

let accessToken = null;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// MongoDB functions
async function connectToMongo() {
  const client = await MongoClient.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  return client;
}

async function insertToMongoDB(sessionCode, idLine) {
  const client = await connectToMongo();
  try {
    const db = client.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const document = {
      sessionCode,
      idLine,
      Fecha: new Date(),
    };
    await collection.insertOne(document);
    console.log("Document successfully inserted.");
  } catch (err) {
    console.error("Error inserting into MongoDB:", err);
  } finally {
    client.close();
  }
}

async function findByLineId(lineId) {
  const client = await connectToMongo();
  try {
    const db = client.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME);
    const document = await collection.findOne({ idLine: lineId });
    return document ? document.sessionCode : "";
  } catch (err) {
    console.error("Error finding document in MongoDB:", err);
    return "";
  } finally {
    client.close();
  }
}

// Line Client
const client = new line.Client(LINE_CONFIG);

// Authentication
async function authenticate() {
  const data = qs.stringify({
    grant_type: "client_credentials",
    client_id: process.env.EVA_CLIENT_ID,
    client_secret: process.env.EVA_CLIENT_SECRET,
  });

  try {
    const response = await axios.post(
      process.env.EVA_TOKEN_URL,
      data,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return response.data.access_token;
  } catch (error) {
    console.error("Error authenticating:", error);
  }
}

// Webhook handler
app.post("/webhook", async (req, res) => {
  try {
    const events = req.body.events;

    if (!events || events.length === 0) {
      console.error("No events found in the request.");
      return res.status(400).send("No events found in request.");
    }

    const results = await Promise.all(events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("Error in webhook:", err);
    res.status(500).send("Internal server error.");
  }
});

async function handleEvent(event) {
  console.log("Received event:", event);

  if (!event || !event.type) {
    console.error("Invalid event or missing type:", event);
    return Promise.resolve(null);
  }

  const { type, source, message, postback, replyToken } = event;

  if (!source || !source.userId) {
    console.error("Event missing userId in source:", event);
    return Promise.resolve(null);
  }

  const userId = source.userId;

  try {
    if (type === "postback" && postback) {
      const data = postback.data;
      await evaCall(userId, data, replyToken);
    } else if (type === "message" && message) {
      if (message.type === "text") {
        await evaCall(userId, message.text, replyToken);
      } else if (message.type === "image") {
        await sendImageReply(replyToken);
      } else if (message.type === "audio") {
        const filePath = await getAudio(message.id, LINE_CONFIG.channelAccessToken);
        if (!filePath) {
          console.error("Could not generate filePath. Check getAudio function.");
          return "Error filepath";
        }
        console.log("File saved at:", filePath);
        console.log("Does the file exist?", fs.existsSync(filePath));
        console.log("Proceeding to transcription...");
        const transcribeMsg = await transcribeAudio(filePath);
        console.log("Transcription result:", transcribeMsg);
        await evaCall(userId, transcribeMsg, replyToken);
      } else {
        console.log("Unsupported message type:", message.type);
      }
    } else {
      console.log("Unsupported event type:", type);
    }
  } catch (err) {
    console.error("Error handling event:", err);
  }
}

async function getAudio(messageId, accessToken) {
  try {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const response = await axios.get(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
      responseType: 'arraybuffer'
    });

    const filePath = path.join('/tmp', `audio-${messageId}.mp3`);
    fs.writeFileSync(filePath, response.data);
    console.log("Audio successfully downloaded to:", filePath);
    return filePath;

  } catch (error) {
    console.error("Error downloading audio:", error);
    return null;
  }
}

async function transcribeAudio(localFilePath) {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(localFilePath),
      model: "whisper-1",
    });

    console.log("Transcription obtained:", transcription);
    return transcription.text;

  } catch (error) {
    console.error("Error transcribing audio:", error);
    return null;
  }
}

// Reply helpers
async function sendImageReply(replyToken) {
  const message = {
    replyToken,
    messages: [
      {
        type: "text",
        text: "An image was received, but we are currently not prepared to process it."
      },
    ],
  };
  await sendMessageLineAPI(message);
}

async function sendMessageLineAPI(message) {
  try {
    const response = await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      message,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );
    console.log("Message sent:", response.data);
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

// Eva Call
async function evaCall(id, msg, replyToken) {
  let sessionCode = await findByLineId(id);

  try {
    const response = await axios.post(
      `${EVA_CONFIG.evaBroker}/org/${EVA_CONFIG.orgUuid}/env/${EVA_CONFIG.envUuid}/bot/${EVA_CONFIG.botKey}/conversations/${sessionCode}`,
      { text: msg },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "API-KEY": EVA_CONFIG.apiKey,
          CHANNEL: EVA_CONFIG.channel,
          OS: "Windows",
          "USER-REF": id,
          LOCALE: "es-ES",
          "OS-VERSION": "10",
          "BUSINESS-KEY": "USER-123",
          Authorization: "Bearer " + accessToken
        },
      }
    );

    const sessionCodeEva = response.data.sessionCode;

    if (sessionCode !== sessionCodeEva) {
      await insertToMongoDB(sessionCodeEva, id);
    }

    const messages = response.data.answers.map((answer) => ({
      type: "text",
      text: answer.content,
    }));

    await sendMessageLineAPI({ replyToken, messages });

  } catch (error) {
    if (error.response) {
      const { status, data } = error.response;

      if (status === 401) {
        console.error("Error 401: Invalid or expired token. Re-authenticating...");
        try {
          accessToken = await authenticate();
          console.log("New token generated:", accessToken);
          await evaCall(id, msg, replyToken);
        } catch (authError) {
          console.error("Error re-authenticating:", authError);
        }
      } else if (status === 500) {
        console.error("Error 500 in evaCall:", data.message);
        console.error("Error details:", data);
      } else {
        console.error(`Error in evaCall with code ${status}:`, data);
      }
    } else {
      console.error("Error in evaCall:", error.message);
    }
  }
}

// Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = { app };