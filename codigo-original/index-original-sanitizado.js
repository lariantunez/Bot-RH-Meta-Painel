//-------------------------------------------------------------------------------------------------Carregamento do .env (variáveis como: email, senhas, tokens)-------------------------------
require("dotenv").config(); 

//-------------------------------------------------------------------------------------------------Importando as bibliotecas------------------------------------------------------------------
//cria o servidor que permite "falar com o BOT"
const express = require("express"); 
//é o mensageiro usado para "chamar/ligar" a API do WhatsApp na Meta).
const axios = require("axios"); 
//biblioteca para envio de e-mails via SMTP, usado quando alguem entra na fila.
const nodemailer = require("nodemailer"); 
// MongoDB (persistência opcional / futura)
const mongoose = require("mongoose");
// filesystem (persistência de contatos no painel)
const fs = require("fs");
const path = require("path");
// multer: upload de arquivos (anexos pelo painel)
const multer = require("multer");
const uploadDir = path.join(process.cwd(), "uploads_tmp");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB
//-------------------------------------------------------------------------------------------------Inicializa o app Express.-----------------------------------------------------------------
const app = express(); //Cria um servidor e aceita mensagens em formato JSON.
app.use(express.json());

//-------------------------------------------------------------------------------------------------Logs de diagnóstico para conferir se as variáveis chegaram.-------------------------------
 /* 1ºMostra qual e-mail está sendo usado pra enviar
    2ºconfirma se a senha existe (sem mostrar a senha)
    3ºremove espaços invisíveis
    4ºevita erro besta tipo: “senha errada” (quando na verdade era um espaço)
  */
console.log("SMTP_USER:", (process.env.SMTP_USER||"").trim());
console.log("SMTP_PASS len:", (process.env.SMTP_PASS||"").trim().length);

//-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const PORT = process.env.PORT || 3000; //porta onde o servidor está rodando
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "COLE_O_VERIFY_TOKEN_AQUI"; // token de validação na Meta

//-------------------------------------------------------------------------------------------------MongoDB Atlas (Koyeb)-------------------------------------------------------------------
// Usa a variável de ambiente MONGODB_URI (configurada no Koyeb).
// Esta conexão NÃO altera o funcionamento atual do bot; serve para garantir que o app
// consiga se conectar ao Atlas (e permitir evoluções futuras com persistência real).
async function initMongo() {
  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.warn("⚠️  MONGODB_URI não definida. MongoDB não será utilizado nesta execução.");
    return;
  }
  try {
    // Evita warning de strictQuery em versões antigas
    try { mongoose.set("strictQuery", true); } catch (e) {}

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    console.log("✅ MongoDB conectado com sucesso.");
    try { initMongoModelsOnce(); } catch (e) {}
    // reidrata histórico em sequência (não paralelo) para garantir ordem
    setTimeout(async () => {
      try { await bootstrapContactsFromMongo(); } catch (e) {}
      try { await bootstrapTopicsFromMongo(); } catch (e) {}
      try { await bootstrapConversationsFromMongo(); } catch (e) {}
      try { await loadBlockedFromMongo(); } catch (e) {}
    }, 1500);
  } catch (err) {
    console.error("❌ Falha ao conectar no MongoDB:", err?.message || err);
  }
}

// inicia a conexão (não bloqueia o bot)
initMongo().catch(() => {});


//-------------------------------------------------------------------------------------------------
// MongoDB: persistência REAL do histórico (painel tipo WhatsApp Web)
//-------------------------------------------------------------------------------------------------
// Coleção de mensagens (1 documento por mensagem).
// Mantemos também um "bootstrap" que reidrata o convoStore ao subir o servidor,
// garantindo que, mesmo após restart/deploy do Koyeb, o histórico continue disponível.

let MongoMessage = null;
let MongoBlocked = null;
let MongoContact = null;
let MongoTopic = null;
function mongoReady() {
  return mongoose?.connection?.readyState === 1 && MongoMessage;
}

function initMongoModelsOnce() {
  if (MongoMessage) return;

  const messageSchema = new mongoose.Schema(
    {
      waId: { type: String, index: true, required: true },
      ts: { type: Date, index: true, required: true }, // timestamp real (Date)
      tsISO: { type: String, required: true },         // timestamp em ISO (compatível com o painel atual)
      from: { type: String, enum: ["user", "bot", "human", "system"], required: true },
      text: { type: String, default: "" },
      mediaId:   { type: String, default: "" },
      mediaType: { type: String, default: "" },
      mediaName: { type: String, default: "" },
      mediaMime: { type: String, default: "" },
    },
    { collection: "messages", minimize: true }
  );

  // Evita erro de "OverwriteModelError" em hot-reload/local
  MongoMessage = mongoose.models.MongoMessage || mongoose.model("MongoMessage", messageSchema);

  // Contatos persistidos (nome, telefone formatado, atualizadoEm)
  const contactSchema = new mongoose.Schema(
    {
      waId: { type: String, unique: true, index: true, required: true },
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
      updatedAt: { type: Date, default: Date.now },
    },
    { collection: "contacts", minimize: true }
  );
  MongoContact = mongoose.models.MongoContact || mongoose.model("MongoContact", contactSchema);

  // Contatos bloqueados persistidos no Mongo
  const blockedSchema = new mongoose.Schema(
    { waId: { type: String, unique: true, index: true, required: true } },
    { collection: "blocked", minimize: true }
  );
  MongoBlocked = mongoose.models.MongoBlocked || mongoose.model("MongoBlocked", blockedSchema);

  // Assunto/etiqueta do atendimento humano por conversa (para reabrir painel com a tag correta)
  const topicSchema = new mongoose.Schema(
    {
      waId: { type: String, unique: true, index: true, required: true },
      topicKey: { type: String, default: "" },
      topicLabel: { type: String, default: "" },
      updatedAt: { type: Date, default: Date.now },
    },
    { collection: "topics", minimize: true }
  );
  MongoTopic = mongoose.models.MongoTopic || mongoose.model("MongoTopic", topicSchema);

}

async function persistMessageToMongo({ waId, tsISO, fromWho, text, mediaId, mediaType, mediaName, mediaMime }) {
  try {
    if (!mongoReady()) return;
    const tsDate = new Date(tsISO);
    await MongoMessage.create({
      waId,
      ts: isNaN(tsDate.getTime()) ? new Date() : tsDate,
      tsISO,
      from: fromWho,
      text: (text ?? "").toString(),
      mediaId:   mediaId   || "",
      mediaType: mediaType || "",
      mediaName: mediaName || "",
      mediaMime: mediaMime || "",
    });
  } catch (e) {
    // não quebra o bot se o Mongo oscilar
    console.warn("⚠️  Mongo persistMessage falhou:", e?.message || e);
  }
}


// --- Contatos: persistência em Mongo (para não perder nome ao reiniciar) ---
async function upsertContactToMongo({ waId, name, phone }) {
  try {
    if (!mongoReady() || !MongoContact) return;
    await MongoContact.updateOne(
      { waId },
      { $set: { name: (name || "").toString(), phone: (phone || "").toString(), updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.warn("⚠️  Mongo upsertContact falhou:", e?.message || e);
  }
}

async function deleteContactFromMongo(waId) {
  try {
    if (!mongoReady() || !MongoContact) return;
    await MongoContact.deleteOne({ waId: (waId || "").toString() });
  } catch (e) {
    console.warn("⚠️  Mongo deleteContact falhou:", e?.message || e);
  }
}

async function bootstrapContactsFromMongo() {
  try {
    if (!mongoReady() || !MongoContact) return;
    const rows = await MongoContact.find({}, { _id: 0, waId: 1, name: 1, phone: 1 }).lean();
    for (const r of (rows || [])) {
      const id = (r.waId || "").toString();
      if (!id) continue;
      contactsStore.set(id, {
        waId: id,
        name: (r.name || "").toString(),
        phone: (r.phone || "").toString(),
        updatedAt: nowISO(),
      });
      const saved = contactsStore.get(id);
      if (saved?.name) userNames.set(id, saved.name);
    }
    console.log(`✅ Contatos reidratados do Mongo: ${rows?.length || 0}`);
  } catch (e) {
    console.warn("⚠️  Mongo bootstrapContacts falhou:", e?.message || e);
  }
}

// --- Topics/Assuntos: persistência em Mongo (para manter etiqueta após restart) ---
async function upsertTopicToMongo(waId, topicObj) {
  try {
    if (!mongoReady() || !MongoTopic) return;
    const t = topicObj || {};
    await MongoTopic.updateOne(
      { waId: (waId || "").toString() },
      { $set: { topicKey: (t.key || "").toString(), topicLabel: (t.label || "").toString(), updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.warn("⚠️  Mongo upsertTopic falhou:", e?.message || e);
  }
}

async function bootstrapTopicsFromMongo() {
  try {
    if (!mongoReady() || !MongoTopic) return;
    const rows = await MongoTopic.find({}, { _id: 0, waId: 1, topicKey: 1, topicLabel: 1 }).lean();
    for (const r of (rows || [])) {
      const id = (r.waId || "").toString();
      if (!id) continue;
      const topicKey = (r.topicKey || "").toString();
      const topicLabel = (r.topicLabel || "").toString();
      if (topicKey || topicLabel) {
        handoverTopics.set(id, { key: topicKey, label: topicLabel || topicKey });
      }
    }
    console.log(`✅ Assuntos reidratados do Mongo: ${rows?.length || 0}`);
  } catch (e) {
    console.warn("⚠️  Mongo bootstrapTopics falhou:", e?.message || e);
  }
}


// Recarrega histórico do Mongo para o convoStore (mantém o painel compatível, sem mexer nas rotas).
// Por segurança, limita a N mensagens por conversa.
async function bootstrapConversationsFromMongo() {
  try {
    if (!mongoReady()) {
      console.warn("⚠️  bootstrapConversations: Mongo não pronto, pulando.");
      return;
    }

    console.log("🔄 Iniciando reidratação de conversas do Mongo...");
    const waIds = await MongoMessage.distinct("waId");
    console.log(`📋 Conversas encontradas no Mongo: ${waIds.length}`);

    for (const waId of waIds) {
      const rows = await MongoMessage.find({ waId })
        .sort({ ts: 1 })
        .limit(500)
        .lean();

      if (!rows || !rows.length) continue;

      const c = getConvo(waId);
      c.messages = rows.map(r => { const m = { ts: r.tsISO || r.ts, from: r.from, text: r.text || "" }; if (r.mediaId) { m.mediaId = r.mediaId; m.mediaType = r.mediaType || ""; m.mediaName = r.mediaName || ""; m.mediaMime = r.mediaMime || ""; } return m; });
      c.unread = 0;
      c.lastMessageAt = rows[rows.length - 1].tsISO || rows[rows.length - 1].ts;

      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].from === "user") { c.lastUserMessageAt = rows[i].tsISO || rows[i].ts; break; }
      }
    }

    console.log(`✅ Conversas reidratadas do Mongo: ${waIds.length}`);
    broadcast("conversations", { at: nowISO(), source: "mongo_bootstrap" });
  } catch (e) {
    console.warn("⚠️  Mongo bootstrapConversations falhou:", e?.message || e);
  }
}

//-------------------------------------------------------------------------------------------------Build info (painel)-------------------------------------------------------------------
const BUILD_LABEL = (() => {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const s = fmt.format(d); // ex: 20/02/2026 10:31
  const parts = s.split(" ");
  return parts.length >= 2 ? (parts[0] + " às " + parts[1]) : s;
})();

function setNoCache(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
}

//-------------------------------------------------------------------------------------------------Delay para deixar o Bot mais "Humano"----------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));//Coloca o Bt para “dormir” por ms milissegundos.

// ===============================
// CONTROLE DE ENVIO (ANTI-RATE-LIMIT)
// ===============================
// WhatsApp Cloud pode retornar: (#131056) pair rate limit hit.
// Para reduzir isso: fila por destinatário + intervalo mínimo entre envios.
const sendQueues = new Map(); // to -> Promise chain
const lastSentAt = new Map(); // to -> timestamp ms
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 900); // ajuste fino se necessário

function enqueueSend(to, fn) {
  const prev = sendQueues.get(to) || Promise.resolve();
  const next = prev
    .catch(() => {}) // não quebra a fila se um envio falhar
    .then(async () => {
      const last = lastSentAt.get(to) || 0;
      const gap = Date.now() - last;
      if (gap < MIN_GAP_MS) await wait(MIN_GAP_MS - gap);
      const r = await fn();
      lastSentAt.set(to, Date.now());
      return r;
    });
  sendQueues.set(to, next);
  return next;
}

// Trata rate limit específico (#131056)
function isPairRateLimit(err) {
  const data = err?.response?.data;
  const code = data?.error?.code;
  return code === 131056;
}


async function postWithRetry(url, body, options, attempts = 2) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await axios.post(url, body, options);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await wait(350);
    }
  }
  throw lastErr;
}


//-------------------------------------------------------------------------------------------------Envio da mensagem de texto bot via WhatsApp Cloud API---------------------------------------
/*
1ºMonta o endereço da Meta
2ºDiz pra quem mandar
3ºDiz o que mandar
4ºUsa o token secreto
5ºEnvia
*/
async function sendText(to, text) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  return enqueueSend(to, async () => {
    try {
      await postWithRetry(url, body, { headers }, 2);
      try { logMessage(to, "bot", text); } catch (e) {}
    } catch (e) {
      // Se estourou rate limit, loga e não tenta disparar em loop
      const data = e?.response?.data;
      if (isPairRateLimit(e)) {
        console.error("⚠️ Rate limit (#131056) ao enviar. Aguarde alguns segundos e tente novamente.");
      } else {
        console.error("Erro ao enviar:", data || e.message);
      }
    }
  });
}

//-------------------------------------------------------------------------------------------------Envio da mensagem de texto humano via WhatsApp Cloud API(painel /admin)-------------
/*
1ºMonta o endereço da Meta
2ºDiz pra quem mandar
3ºDiz o que mandar
4ºUsa o token secreto
5ºEnvia
*/

async function sendHumanText(to, text) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  return enqueueSend(to, async () => {
    try {
      await postWithRetry(url, body, { headers }, 2);
      try { logMessage(to, "human", text); } catch (e) {}
    } catch (e) {
      const data = e?.response?.data;
      if (isPairRateLimit(e)) {
        console.error("⚠️ Rate limit (#131056) ao enviar (humano). Aguarde alguns segundos.");
      } else {
        console.error("Erro ao enviar (humano):", data || e.message);
      }
    }
  });
}


//-------------------------------------------------------------------------------------------------Envio de mídia (anexo) pelo painel /admin--------------------------------------------------
// Suporta imagem, documento, vídeo e áudio enviados pelo painel do RH.
async function sendHumanMedia(to, { type, mediaId, caption, filename }) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;
  let body;
  if (type === "image") {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { id: mediaId, caption: caption || "" },
    };
  } else if (type === "video") {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "video",
      video: { id: mediaId, caption: caption || "" },
    };
  } else if (type === "audio") {
    body = {
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: { id: mediaId },
    };
  } else {
    // document (PDF, docx, xlsx, etc.)
    body = {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, caption: caption || "", filename: filename || "arquivo" },
    };
  }
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
  return enqueueSend(to, async () => {
    try {
      await postWithRetry(url, body, { headers }, 2);
      const label = caption ? `[Anexo: ${caption}]` : `[Anexo enviado]`;
      try { logMessage(to, "human", label); } catch (e) {}
    } catch (e) {
      const data = e?.response?.data;
      if (isPairRateLimit(e)) {
        console.error("⚠️ Rate limit (#131056) ao enviar mídia (humano). Aguarde alguns segundos.");
      } else {
        console.error("Erro ao enviar mídia (humano):", data || e.message);
      }
    }
  });
}

// Faz upload de arquivo binário para a API da Meta e retorna o mediaId
async function uploadMediaToMeta(filePath, mimeType) {
  const FormData = require("form-data");
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", fs.createReadStream(filePath), { contentType: mimeType });
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/media`;
  const resp = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      ...form.getHeaders(),
    },
  });
  return resp.data.id;
}

//-------------------------------------------------------------------------------------------------iniciar conversa com alguém que ainda não falou com o bot---------------------------

//Essa função serve para iniciar uma conversa com alguém que ainda não falou com o bot, ou que ficou mais de 24 horas sem responder.

async function sendHelloWorldTemplate(to) {
  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;//url da meta
  const body = {//corpo da mensagem
    messaging_product: "whatsapp",
    to,
    type: "template",//o tipo da mensagem é um template
    template: {// mensagem modelo aprovada pela meta
      name: "hello_world",
      language: { code: "en_US" },
    },
  };
  const headers = {//cabeçario da função, mesma identidade, mesmo token
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
  // retorna a resposta para o caller poder validar no endpoint de teste
  return axios.post(url, body, { headers });
}

//------------------------------------------------------------------------------------LISTA DE MENUS PRINCIPAIS---------------------------------------------------------------------------------------

// Mensagem de Saudação
const WELCOME_1 = "Olá 👋, eu sou o assistente virtual do RH.";

//Menu principal
const ROOT_MENU = [
  "O que você deseja fazer hoje?",
  "",
  "1️⃣ Informações sobre Ponto (Multi / My Ahgora)",
  "",
  "2️⃣ Folha & Benefícios (Meu RH)",
  "",
  "3️⃣ Dúvidas sobre holerite",
  "",
  "4️⃣ Falar com atendente",
].join("\n");

// Menu 1 Informações sobre Ponto (Multi / My Ahgora)
const PONTO_MENU = [
  "Por favor, escolha uma opção:",
  "",
  "1️⃣ Registrar ponto",
  "",
  "2️⃣ Consultar ponto",
  "",
  "3️⃣ Solicitar abonamento de horas",
  "",
  "4️⃣ Cancelar batida de ponto",
  "",
  "5️⃣ Incluir batida de ponto",
  "",
  "6️⃣ Enviar atestado",
  "",
  "7️⃣ Aprovação do espelho de ponto",
  "",
  "8️⃣ Falar com atendente",
  "",
  "9️⃣ Retornar ao menu inicial",
].join("\n");
// Menu 2 Folha & Benefícios (Meu RH / TOTVS)
const FOLHA_MENU = [
  "Por favor, escolha uma opção:",
  "",
  "1️⃣ Acessar histórico de pagamentos",
  "",
  "2️⃣ Consultar histórico salarial",
  "",
  "3️⃣ Consultar informe de rendimentos",
  "",
  "4️⃣ Falar com atendente",
  "",
  "5️⃣ Retornar ao menu inicial",
].join("\n");
//------------------------------------------------------------------------------------LISTA DE PASSO A PASSO SUBMENU 1 (PONTO)---------------------------------------------------------------------------------------

const PASSO_ATESTADO = [
  "*Passo a passo para enviar atestado:*",
  "",
  "🔷 Abra o app ou portal Meu RH e faça login com seu usuário e senha.",
  "🔷 Acesse a aba *Atestado* na parte inferior da tela.",
  "🔷 Preencha as informações: solicitadas, que correspondem aos dados presentes no atestado médico, como o tipo de atestado e o motivo de afastamento (Atestado Médico Faltas Justificadas).",
  "🔷 Anexe o documento: Toque em *Anexar Arquivo* para anexar a foto do atestado ou um documento escaneado em formato PDF.",
  "🔷 Escreva uma justificativa explicativa sobre o atestado.",
  "🔷 Confirme o envio para que o processo seja concluído e o atestado encaminhado ao departamento de Recursos Humanos.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/-aD8-ar6UkI?feature=share",
].join("\n");

const PASSO_HIST_PAGAMENTOS = [
  "*Passo a passo para acessar histórico de pagamentos:*",
  "",
  "🔷 Abra: o aplicativo Meu RH e faça o login.",
  "🔷 Acesse a aba «Pagamentos» na parte inferior da tela.",
  "🔷 Selecione *Envelope de Pagamento*: A partir daí, selecione a opção *Envelope de Pagamento*.",
  "🔷 Escolha o período desejado: O seu envelope de pagamentos estará disponível para visualização e poderá baixar o documento em formato PDF.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/EUcOXLcAAW8",
].join("\n");

const PASSO_HIST_SALARIAL = [
  "*Passo a passo para consultar o histórico salarial:*",
  "",
  "🔷 Abra o app ou portal Meu RH e faça login com seu usuário e senha.",
  "🔷 Acesse a aba *Pagamentos* na parte inferior da tela",
  "🔷 Acesse *Histórico Salarial*",
  "🔷 Ao acessar esta seção, o aplicativo deve exibir o seu histórico salarial desde a admissão, detalhando alterações salariais, como promoções e reajustes.",
  "",
  "*Obs:* Utilize Filtros (se necessário) para buscar por um período específico (início e fim) ou por um motivo de alteração específico.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/tSYB3c9iS_I",
].join("\n");

const PASSO_INFORME = [
  "*Passo a passo para consultar informe de rendimentos*",
  "",
  "🔷 Abra o app ou portal Meu RH e faça login com seu usuário e senha.",
  "🔷 Acesse a aba *Pagamentos* na parte inferior da tela.",
  "🔷 Acesse *Informe de Rendimentos*",
  "🔷 Ao clicar nesta opção, você poderá consultar, baixar ou até mesmo compartilhar o seu informe de rendimentos diretamente pelo aplicativo.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/d4JYoBy1qns",
].join("\n");

//------------------------------------------------------------------------------------MENSAGENS DE FINALIZAÇÃO ---------------------------------------------------------------------------------------

// Mensagem enviada após o envio dos tutoriais
const ASK_BACK = "Deseja voltar ao Menu Inicial?\n\nSim\n\nNão";

//Mensagem de encerramento de uma conversa por inatividade ou pelo usuário
const THANKS = "Atendimento encerrado. Obrigado por entrar em contato com o RH! Se precisar de mais informações, é só mandar uma nova mensagem. 😉";

//Mensagem enviada quando o Bot está em estado hanover (inativo) e o usuário envia uma nova mensagem
const ASK_HANDOVER = "Como posso te ajudar agora?\n\n1️⃣ Retornar ao Menu inicial\n\n2️⃣ Aguardar o atendimento humano";

//------------------------------------------------------------------------------------ENVIO DOS MENUS PRINCIPAL E SUBMENU PONTO-------------------------------------------------------------------------
// Envia saudação e inicia o atendimento (coleta nome antes de mostrar o menu)
async function sendWelcomeAndMenu(to) {
  await sendText(to, WELCOME_1);
  await wait(1000);

  const existingName = (userNames.get(to) || "").toString().trim().replace(/\s+/g, " ");
  if (isValidFullName(existingName)) {
    lastMenuCtx.set(to, { menu: "root", ts: Date.now() });
    await sendText(to, ROOT_MENU);
    setState(to, "await_main_choice");
    return;
  }

  await sendText(to, "Antes de começarmos, me diga seu *nome completo* (nome e sobrenome).");
  setState(to, "await_user_name");
}

// Envia o menu principal (sem saudação)
async function sendRootMenu(to) {
  lastMenuCtx.set(to, { menu: "root", ts: Date.now() });
  lastMenuCtx.set(to, { menu: "root", ts: Date.now() });
  await sendText(to, ROOT_MENU);
}

// Envia submenu do ponto
async function sendPontoMenu(to) {
  lastMenuCtx.set(to, { menu: "ponto", ts: Date.now() });
  await sendText(to, PONTO_MENU);
}
//------------------------------------------------------------------------------------LISTA DE PASSO A PASSO SUBMENU 1 (BENEFICIOS)---------------------------------------------------------------------------------------

const PASSO_REGISTRAR = [
  "*Passo a passo para bater o ponto:*",
  "",
  "🔷 No seu smartphone, abra a aplicativo Multi.",
  "🔷 Na tela inicial do aplicativo, procure pelo botão *REGISTRAR PONTO*,","que permite registrar o ponto.",
  "🔷 Coloque a senha do smartphone para realizar a batida do ponto",
  "🔷 Após a confirmação da sua batida, um comprovante de ponto poderá ser fornecido.",
  "Sincronização offline: Caso não haja conexão de internet, o aplicativo permitirá fazer o registro normalmente,",
  "e os dados serão enviados automaticamente para os servidores assim que o sinal for restabelecido.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/rNXCT_0DoSY?feature=share",
].join("\n");

const PASSO_ESPELHO = [
  "*Passo a passo para acessar o espelho de ponto:*",
  "",
  "🔷 Na tela de login do aplicativo, insira o código da empresa, sua matrícula e senha, e toque em *Entrar*.",
  "🔷 Após o login, você será direcionado para a tela inicial do aplicativo.",
  "🔷 Toque em *Acessar espelho detalhado* para ver as informações do ponto.",
  "🔷 Toque no botão *Trocar competência*, localizado na parte superior esquerda do aplicativo.",
  "🔷 Escolha o período: Selecione o ano e mês do qual deseja visualizar o espelho de ponto e toque em *Ok*.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/ZVTW7ijmqy8",
].join("\n");

const PASSO_ABONO = [
  "*Passo a passo para solicitar um abono:*",
  "",
  "🔷 Abra o aplicativo My Ahgora em seu smartphone.",
  "🔷 Na página inicial toque em *Solicitar abono*.",
  "🔷 Preencha os dados do abono:",
  "   ▫️ Selecione o Motivo do abono",
  "   ▫️ Selecione o período",
  "🔷 Digite uma mensagem para o seu gestor ou RH no campo Mensagem justificando o abonamento.",
  "🔷 Toque em *Adicionar anexo* para selecionar e anexar o arquivo da sua justificativa (como um atestado médico).",
  "🔷 Toque em *Enviar Solicitação de abono* para que o pedido seja encaminhado ao gestor para aprovação.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/wdHo_ZivPbM",
].join("\n");

const PASSO_CANCELAR_BATIDA = [
  "*Passo a passo para solicitar o cancelamento de uma batida de ponto*",
  "",
  "⚠️ O Cancelamento da batida só pode ser realizado no mesmo  dia da marcação",
  "",
  "🔷 Acesse o aplicativo: Abra o aplicativo My Ahgora em seu smartphone.",
  "🔷 Inicie a solicitação: Toque em *Cancelar Batida*",
  "🔷 Selecione o horário que deseja desconsiderar",
  "🔷 Selecione o motivo",
  "🔷 Adicione uma mensagem: Digite uma mensagem para o seu gestor ou RH no campo Mensagem obrigatória.",
  "🔷 Envie a solicitação: Toque em *Incluir batida* para que o pedido seja encaminhado ao gestor para aprovação.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/SFn-UeU7Zhk",
].join("\n");

const PASSO_INCLUIR = [
  "*Passo a passo para solicitar a inclusão de uma batida de ponto*",
  "",
  "🔷 Acesse o aplicativo: Abra o aplicativo My Ahgora em seu smartphone.",
  "🔷 Inicie a solicitação: Toque em *Incluir Batida*",
  "🔷 Selecione a data que deseja incluir a batida",
  "🔷 Selecione o horário que deseja incluir",
  "🔷 Selecione o motivo",
  "🔷 Adicione uma mensagem: Digite uma mensagem para o seu gestor ou RH no campo Mensagem obrigatória.",
  "🔷 Envie a solicitação: Toque em *Incluir batida* para que o pedido seja encaminhado ao gestor para aprovação.",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/V3FTCac-67c",
].join("\n");

const PASSO_APROVACAO_ESPELHO = [
  "*Passo a passo para aprovação do espelho de ponto:*",
  "",
  "🔷 Abra o app ou portal My Ahora e faça login com seu usuário e senha.",
  "🔷 Após o login, você será direcionado para a tela inicial do aplicativo.",
  "🔷 Toque em *Acessar espelho detalhado* para ver as informações do ponto.",
  "🔷 Toque no botão *Trocar competência*, localizado na parte superior esquerda do aplicativo.",
  "🔷 Escolha o período: Selecione o ano e mês do qual deseja visualizar o espelho de ponto e toque em *Ok*.",
  "🔷 Você verá a mensagem *o espelho desse mês está aguardando sua aprovação*.",
  "🔷 Baixe o espelho e Confira",
  "🔷 Após conferir clique em *Aprovar*",
  "",
  "*Acesse o vídeo com o tutorial:*",
  "⏯️ https://youtube.com/shorts/IE5z0Q7Qw68",
].join("\n");

//------------------------------------------------------------------------------------ENVIO PARA ATENDIMENTO HUMANO ---------------------------------------------------------------------------------------

//Mensagem de envio para atendente
function handoverMsg(_position){//posição do usuário na fila de chamados

  // Função que devolve um texto pronto, mas sem informar ao usuário a posição dele na fila(a posição aparece somente no painel /admin)
  return `🔄Encaminhando para um atendente humano. Nosso time responderá em até 24 horas.`;
}

// é um "apelido", Em vez de o código chamar handoverMsg(...), ele pode chamar PASSO_ATENDENTE
const PASSO_ATENDENTE = handoverMsg;

//memória que lembra em que ponto da conversa o usuário está.
const state = new Map();
const lastMenuCtx = new Map(); // { waId: { menu: "root"|"ponto"|"folha", ts: number } }


function setState(waId, newState) {
  state.set(waId, newState);
  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId, at: nowISO() });
}

//------------------------------------------------------------------------------------PAINEL ADMIN STORE (painel /admin)---------------------------------------------------------------------------------
// Guarda nome do usuário (coletado antes do atendimento humano)
const userNames = new Map();
// -----------------------------
// CONTATOS (persistência do painel)
// -----------------------------
// Armazena contatos (nome + telefone editável no painel). Mantém histórico intacto.
// Chave principal é waId (id real do WhatsApp). O "phone" é apenas para exibição no painel.
const contactsStore = new Map(); // waId -> { waId, name, phone, updatedAt }

// Persistência em arquivo local (Koyeb: filesystem efêmero em free tiers; em planos com disk, persiste)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

function loadContactsFromDisk() {
  try {
    ensureDataDir();
    if (!fs.existsSync(CONTACTS_FILE)) return;
    const raw = fs.readFileSync(CONTACTS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const waId = (it?.waId || "").toString().trim();
        if (!waId) continue;
        const name = (it?.name || "").toString().trim();
        const phone = (it?.phone || "").toString().trim();
        contactsStore.set(waId, {
          waId,
          name,
          phone,
          updatedAt: it?.updatedAt || nowISO(),
        });
        // mantém compatibilidade: userNames ainda é usado pelo fluxo do bot
        if (name) userNames.set(waId, name);
      }
    }
  } catch (e) {
    console.error("Falha ao carregar contacts.json:", e?.message || e);
  }
}

function saveContactsToDisk() {
  try {
    ensureDataDir();
    const arr = Array.from(contactsStore.values());
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(arr, null, 2), "utf-8");
  } catch (e) {
    console.error("Falha ao salvar contacts.json:", e?.message || e);
  }
}

function upsertContact(waId, patch) {
  const id = (waId || "").toString().trim();
  if (!id) return null;
  const curr = contactsStore.get(id) || { waId: id, name: "", phone: "", updatedAt: nowISO() };
  const next = {
    waId: id,
    name: (patch?.name ?? curr.name ?? "").toString().trim(),
    phone: (patch?.phone ?? curr.phone ?? "").toString().trim(),
    updatedAt: nowISO(),
  };
  contactsStore.set(id, next);
  if (next.name) userNames.set(id, next.name);
  saveContactsToDisk();
  // espelha no Mongo (não depende do disco do Koyeb)
  upsertContactToMongo(next).catch(() => {});
  broadcast("contacts", { at: nowISO() });
  return next;
}

function deleteContact(waId) {
  const id = (waId || "").toString().trim();
  if (!id) return false;
  contactsStore.delete(id);
  // remove só o nome salvo; histórico e conversa permanecem
  userNames.delete(id);
  saveContactsToDisk();
  // remove também do Mongo
  deleteContactFromMongo(id).catch(() => {});
  broadcast("contacts", { at: nowISO() });
  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId: id, at: nowISO() });
  return true;
}

function getContact(waId) {
  const id = (waId || "").toString().trim();
  return contactsStore.get(id) || null;
}

function getContactName(waId) {
  const c = getContact(waId);
  const nm = (c?.name || "").toString().trim();
  return nm || (userNames.get(waId) || "");
}

function getContactPhone(waId) {
  const c = getContact(waId);
  const ph = (c?.phone || "").toString().trim();
  return ph || toDisplayPhone(waId);
}


// Guarda o assunto (etiqueta) do atendimento humano
const handoverTopics = new Map();

// Histórico de mensagens para o painel
const convoStore = new Map();

// SSE clients para atualização em tempo real (fica atualizando o navegador)
const sseClients = new Map();
let sseSeq = 1;

//gera uma data padrão pra "marcar horário"
function nowISO() { return new Date().toISOString(); }

// ─── LISTA DE BLOQUEIO ────────────────────────────────────────────────────────
const blockedSet = new Set();

// Carrega bloqueados do Mongo (chamado após conexão)
async function loadBlockedFromMongo() {
  try {
    if (!MongoBlocked) return;
    const docs = await MongoBlocked.find({}).lean();
    docs.forEach(d => blockedSet.add(String(d.waId)));
    console.log(`✅ Bloqueados carregados do Mongo: ${blockedSet.size}`);
  } catch (e) { console.warn("⚠️  Falha ao carregar bloqueados do Mongo:", e?.message); }
}

function blockContact(waId) {
  const id = (waId || "").toString().trim();
  if (!id) return false;
  blockedSet.add(id);
  // Persiste no Mongo (sem await — não bloqueia o fluxo)
  if (MongoBlocked) MongoBlocked.updateOne({ waId: id }, { waId: id }, { upsert: true }).catch(() => {});
  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId: id, at: nowISO() });
  return true;
}

function unblockContact(waId) {
  const id = (waId || "").toString().trim();
  if (!id) return false;
  blockedSet.delete(id);
  // Remove do Mongo
  if (MongoBlocked) MongoBlocked.deleteOne({ waId: id }).catch(() => {});
  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId: id, at: nowISO() });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────

// Carrega contatos persistidos (se existirem)
loadContactsFromDisk();

//Garante que a conversa existe para aquele número
function getConvo(waId) {
  if (!convoStore.has(waId)) {
    convoStore.set(waId, { waId, messages: [], unread: 0, lastMessageAt: null, lastUserMessageAt: null });
  }
  return convoStore.get(waId);
}

// Retorna dados de conversa sem criar registro (usado em listas/contatos)
function peekConvo(waId) {
  return convoStore.get(waId) || { waId, messages: [], unread: 0, lastMessageAt: null, lastUserMessageAt: null };
}
//É o “formato” que o navegador entende no SSE
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

//Atualiza o Painel de todos que estão com ele aberto
function broadcast(event, data) {
  for (const res of sseClients.values()) {
    try { sseSend(res, event, data); } catch (e) {}
  }
}

//marca a conversa como lida quando assume o atendimento
function markRead(waId) {
  const c = getConvo(waId);
  c.unread = 0;
  // Não faz broadcast — marcar como lido não precisa re-renderizar o painel
}

/*
Pega a conversa desse usuário (getConvo)
Monta um objeto mensagem com:
horário (ts), quem falou (from),texto (text)
Adiciona no histórico (messages.push)
Atualiza “última mensagem”
Se quem falou foi o usuário:
aumenta “não lidas”
atualiza “última mensagem do usuário”
E no final, manda atualização ao vivo pro painel (broadcast)
.*/
function logMessage(waId, fromWho, text, mediaFields) {
  const c = getConvo(waId);
  const msg = { ts: nowISO(), from: fromWho, text: (text ?? "").toString() };
  if (mediaFields) {
    if (mediaFields.mediaId)   msg.mediaId   = mediaFields.mediaId;
    if (mediaFields.mediaType) msg.mediaType = mediaFields.mediaType;
    if (mediaFields.mediaName) msg.mediaName = mediaFields.mediaName;
    if (mediaFields.mediaMime) msg.mediaMime = mediaFields.mediaMime;
  }
  // persiste no Mongo (não bloqueia o fluxo)
  persistMessageToMongo({ waId, tsISO: msg.ts, fromWho, text: msg.text, ...(mediaFields || {}) });
  c.messages.push(msg);
  c.lastMessageAt = msg.ts;
  if (fromWho === "user") {
    c.lastUserMessageAt = msg.ts;
    c.unread = (c.unread || 0) + 1;
  }
  broadcast("conversation", { waId, at: nowISO() });
  broadcast("conversations", { at: nowISO() });
}


//------------------------------------------------------------------------------------FLUXO MENU 3 (DÚVIDA SOBRE HOLERITE) ---------------------------------------------------------------------------------------

//é uma meméria temporária, para bot saber, para cada pessoa, em que ponto do envio do holerite ela esta
const holeriteSessions = new Map(); 

//Define o tempo antes de o bot encaminhar para o atendimento humano após receber a mensagem e o print do holerit
const HOLERITE_FORWARD_MS = 03* 1000; // 3 segundos

//Essa função limpa o temporizador da sessão do usuário(tempo de inatividade).
function clearHoleriteTimer(from) {
  const sess = holeriteSessions.get(from);//pega a sessão do número específico.
  if (sess?.forwardTimer) { //verifica se há um timer ativo.
    clearTimeout(sess.forwardTimer); //cancela o timer, evitando que ele dispare automaticamente (por exemplo, se o usuário já mandou tudo e o bot não precisa mais encaminhar).
    sess.forwardTimer = null;//garante que o campo fique “zerado”.
  }
}

//------------------------------------------------------------------------------------ ENVIO PARA ATENDIMENTO HUMANO ---------------------------------------------------------------------------------------
/*responsável por agendar o encaminhamento automático do caso para um atendente humano,
  caso o usuário não envie tudo o que é necessário (texto + imagem) no tempo limite.*/
function armHoleriteForward(from) {
   clearHoleriteTimer(from);

  //Recupera a sessão atual do usuário (se existir) a partir do holeriteSessions
  const sess = holeriteSessions.get(from) || { hasText: false, hasImage: false, forwardTimer: null };

  //Aqui ele cria o temporizador (setTimeout) que vai rodar depois do tempo definido
  sess.forwardTimer = setTimeout(async () => {
    
    const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
    setState(from, "handover");
    stopInactivity(from); // não encerrar por inatividade durante handover

//------------------------------------------------------------------------ ORDEM DE CHAMADOS ENCAMINHADOS PARA ATENDIMENTO HUMANO ----------------------------------------------------------------------------

//Esse trecho tenta enfileirar e notificar o RH por email sobre o novo atendimento
    try {
      const position = enqueueHandover(from); //adiciona o usuário à fila de atendimento humano e retorna a posição (ex.: 1º da fila, 2º, etc.).
      await notifyRH({ from, position }); //envia um e-mail ou alerta interno pro time do RH avisando:
    } catch (err) {
      console.error("Falha ao notificar RH:", err?.message || err);
    }

  }, HOLERITE_FORWARD_MS);//é o tempo de espera definido anteriormente(5 segundos)
  holeriteSessions.set(from, sess);
}

//----------------------------------------------------------------------------------------- CONTROLE DE INATIVIDADE ----------------------------------------------------------------------------------------

const inactivityTimers = new Map(); //guarda um timer por usuário pra detectar quem não interagiu mais
const INACTIVITY_MS = 3 * 60 * 1000; // 3 minutos

//Serve pra cancelar o contador de inatividade de um usuário específico.
function stopInactivity(from) {
  if (inactivityTimers.has(from)) { //verifica se o timer existe.
    clearTimeout(inactivityTimers.get(from)); //para o cronômetro.
    inactivityTimers.delete(from); //remove o registro do mapa.
  }
}

/*toda vez que o usuário interage com o bot (manda uma nova mensagem).
A função “reinicia” o cronômetro de inatividade daquele número.*/
function resetInactivityTimer(from) {

    // Se o usuário está em atendimento humano (handover) OU em atendimento manual via painel (/admin),
    // o bot não deve criar/rodar timer de inatividade.
    if (state.get(from) === "handover" || state.get(from) === "manual") return;
  stopInactivity(from); //Cancela qualquer timer antigo de inatividade que esse número possa ter.

  const t = setTimeout(async () => { //Cria um novo temporizador (timer) e guarda a referência na variável t.

    const current = state.get(from); //Quando o tempo expira, o bot verifica novamente o estado
    if (current === "handover" || current === "manual" || current === "ended") return;
        await sendText(from, THANKS); //Caso contrário, significa que o usuário ficou inativo, então:
    setState(from, "ended");
  }, INACTIVITY_MS); // Define o tempo de espera
  inactivityTimers.set(from, t);
}
//----------------------------------------------------------------------------------------- PADRONIZAÇÃO DE ENTRADA DE TEXTO ----------------------------------------------------------------------------------------

/*Garante que o texto de entrada seja tratado de forma padronizada, removendo variações.
Usada quando o bot precisa comparar respostas do usuário (“sim”, “Sim”, “ SIM ” → tudo vira “sim”).*/
async function safeSendText(to, text) {
  try {
    await sendText(to, text);
    return true;
  } catch (e) {
    return false;
  }
}

function normalize(txt) {
  return (txt || "").toString().trim().toLowerCase();
}


function isValidFullName(nameRaw) {
  const name = (nameRaw || "").toString().trim().replace(/\s+/g, " ");
  const parts = name.split(" ").filter(Boolean);
  const meaningful = parts.filter(p => /[A-Za-zÀ-ÿ]/.test(p) && p.length >= 2);
  return meaningful.length >= 2;
}

//----------------------------- ATENDIMENTO HUMANO: ASSUNTO (ETIQUETAS) -----------------------------

const HUMAN_TOPIC_PROMPT = [
  "Antes de falar com um atendente, me diga: a sua dúvida é sobre:",
  "",
  "1️⃣ Benefícios",
  "",
  "2️⃣ Ponto",
  "",
  "3️⃣ Folha de pagamento",
  "",
  "4️⃣ Férias",
  "",
  "5️⃣ Rescisão",
  "",
  "6️⃣ Consignado",
  "",
  "Responda com o número ou com o texto."
].join("\n");

function parseHumanTopic(rawNorm) {
  const t = (rawNorm || "").toString().trim().toLowerCase();
  if (!t) return null;

  if (t === "1") return { key: "beneficios", label: "Benefícios" };
  if (t === "2") return { key: "ponto", label: "Ponto" };
  if (t === "3") return { key: "folha", label: "Folha de pagamento" };
  if (t === "4") return { key: "ferias", label: "Férias" };
  if (t === "5") return { key: "rescisao", label: "Rescisão" };
  if (t === "6") return { key: "consignado", label: "Consignado" };

  if (t.includes("benef")) return { key: "beneficios", label: "Benefícios" };
  if (t.includes("ponto") || t.includes("batida") || t.includes("ahgora")) return { key: "ponto", label: "Ponto" };
  if (t.includes("folha") || t.includes("pagamento") || t.includes("sal")) return { key: "folha", label: "Folha de pagamento" };
  if (t.includes("feri") || t.includes("férias") || t.includes("ferias")) return { key: "ferias", label: "Férias" };
  if (t.includes("rescis") || t.includes("demiss") || t.includes("deslig")) return { key: "rescisao", label: "Rescisão" };
  if (t.includes("consign")) return { key: "consignado", label: "Consignado" };

  return null;
}

async function beginHumanRouting(from) {
  state.set(from, "await_human_topic");
  await sendText(from, HUMAN_TOPIC_PROMPT);
}

//----------------------------------------------------------------------------- CONFIGURAÇÃO ENVIO DE EMAIL PARA FILA DE CHAMADOS ------------------------------------------------------------------------------------

// Lê as credenciais do .env. para conseguir enviar o email
const smtpUser = (process.env.SMTP_USER || "").trim();//o e-mail usado para enviar as notificações
const smtpPass = (process.env.SMTP_PASS || "").replace(/\s+/g, "").trim(); //a senha de app do Gmail (não é a senha normal da conta).

//Cria o transporte SMTP (é o “canal” que envia os e-mails).
const mailer = nodemailer.createTransport({
  service: "gmail",//usa as configurações padrão do Gmail.
  auth: { user: smtpUser, pass: smtpPass },//autenticação com usuário e senha.
});

// Faz um teste automático ao iniciar o servidor com o gmail.
mailer.verify((err) => {
  if (err) {
    console.error("❌ SMTP verify FAILED:", err);//Se der erro (senha errada, autenticação bloqueada, etc.), o log mostra:
  } else {
    console.log("✅ SMTP verify OK");//Se as credenciais estiverem corretas, aparece no console:
  }
});

//Configura a lista de forma ordenada

const handoverQueue = []; // é um array (LISTA ORDENADA DE VALORES) que guarda a ordem de chegada dos usuários que estão esperando atendimento humano.
const inQueue = new Set(); //é um Set (estrutura sem duplicados) usado só pra evitar que o mesmo número entre na fila mais de uma vez.

//Verifica se o úsuário ja esta na fila

function enqueueHandover(from) {
  if (!inQueue.has(from)) { //Verifica se o número já está na fila
    inQueue.add(from);//Se não está, adiciona o número para marcá-lo como “em fila”,e também insere no array handoverQueue com o horário atual.
    handoverQueue.push({ from, ts: Date.now() }); //procura a posição (base 0), por isso soma +1 para deixar “base 1” (ex.: 1º, 2º, 3º).
  }
  broadcast("conversations", { at: nowISO() });

  broadcast("conversation", { waId: from, at: nowISO() });

  return handoverQueue.findIndex((x) => x.from === from) + 1; // posição 1-based
}

//Remove o usuário da fila quando ele for atendido ou a conversa encerrar.

function removeFromQueue(from) {
  const idx = handoverQueue.findIndex((x) => x.from === from);
  if (idx >= 0) handoverQueue.splice(idx, 1);
  inQueue.delete(from);

  broadcast("conversations", { at: nowISO() });
  broadcast("conversation", { waId: from, at: nowISO() });
}

//----------------------------------------------------------------------------- MENSAGEM DO EMAIL COM O CHAMADO ENVIADO AO RH---------------------------------------------------------------------------------

async function notifyRH({ from, position }) {/*Declara uma função assíncrona (porque ela usa await dentro).
Recebe um objeto com dois dados:
from = o número do usuário (ex.: "5511999999999"),
position = a posição dele na fila (1, 2, 3...).*/

  const subject = `BOT RH - Aguardando Atendimento (#${position}) - ${from}`; //Cria o assunto (subject) do e-mail.
  const fmtDate = new Date().toLocaleString("pt-BR", { hour12: false }); //Cria a data e hora atual no formato brasileiro
  const body = //Cria o corpo do e-mail (body)
`Olá, RH 👋

Há um novo contato aguardando atendimento humano no WhatsApp.

• Número: ${from}
• Posição na fila: #${position}
• Recebido em: ${fmtDate}

Sugestão: responder via WhatsApp Web
https://wa.me/${from.replace(/\D/g, "")}

Obs.: quando o atendimento for iniciado/concluído, o contato pode sair da fila automaticamente (ou quando o usuário retornar ao menu).`;

//Envio do email
  await mailer.sendMail({ //Envia o e-mail
    from: process.env.NOTIFY_FROM || process.env.SMTP_USER,//o remetente.Se existir NOTIFY_FROM no .env, usa ele.Caso contrário, usa SMTP_USER (o e-mail autenticado).
    to: process.env.NOTIFY_TO, //destinatário
    subject, //o título do e-mail (montado lá em cima).
    text: body, //o corpo do e-mail (sem HTML, só texto puro).
  });
}
//--------------------------------------------------------------------TRECHO RESPONSÁVEL POR RECEBER E RESPONDER AS MENSAGENS -----------------------------------------------------------------------

//Verificar conexão coma Meta

/*Esse endpoint é chamado uma única vez quando você conecta seu bot ao Meta Developers (WhatsApp Cloud API).
Ele serve apenas para confirmar que o servidor do seu bot está ativo e seguro.*/
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];//O Meta envia esse valor ("subscribe") pra indicar uma verificação.
  const token = req.query["hub.verify_token"];// É o token que você configurou no painel e também no seu código (VERIFY_TOKEN).
  const challenge = req.query["hub.challenge"];//um número que o Meta gera e espera que você devolva para confirmar que seu servidor é válido.
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);/*Se o mode for "subscribe" e o token for igual ao que você definiu (VERIFY_TOKEN), então o bot responde com o challenge.
      Isso confirma a verificação e o Meta ativa o webhook.*/
  }
  return res.sendStatus(403);// Se algo estiver errado → retorna 403 Forbidden.
});

//Toda mensagem enviada por um usuário no WhatsApp é enviada pelo Meta ao seu servidor via POST.
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0];//é o caminho dentro do JSON que contém a mensagem real.
    const msg = change?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);//se não houver mensagem (por exemplo, é só confirmação de entrega), o bot ignora e responde 200 para o Meta (pra não gerar erro).

    const from = msg.from; //from é o número do usuário que enviou a mensagem (exemplo: "5511999999999").

    // ── BLOQUEIO: ignora completamente mensagens de números bloqueados ──────────
    if (blockedSet.has(from)) return res.sendStatus(200);

    const text = msg.text?.body || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "";
    const n = normalize(text);

    // ── Detectar mídia recebida (imagem, documento, áudio, vídeo, sticker) ──────
    let mediaFields = null;
    if (msg.image) {
      mediaFields = { mediaId: msg.image.id, mediaType: "image", mediaName: "", mediaMime: msg.image.mime_type || "image/jpeg" };
    } else if (msg.document) {
      mediaFields = { mediaId: msg.document.id, mediaType: "document", mediaName: msg.document.filename || "documento", mediaMime: msg.document.mime_type || "application/octet-stream" };
    } else if (msg.audio) {
      mediaFields = { mediaId: msg.audio.id, mediaType: "audio", mediaName: "", mediaMime: msg.audio.mime_type || "audio/ogg" };
    } else if (msg.video) {
      mediaFields = { mediaId: msg.video.id, mediaType: "video", mediaName: "", mediaMime: msg.video.mime_type || "video/mp4" };
    } else if (msg.sticker) {
      mediaFields = { mediaId: msg.sticker.id, mediaType: "sticker", mediaName: "", mediaMime: msg.sticker.mime_type || "image/webp" };
    } else if (msg.voice) {
      mediaFields = { mediaId: msg.voice.id, mediaType: "audio", mediaName: "", mediaMime: msg.voice.mime_type || "audio/ogg" };
    }

    const logText = mediaFields ? (text || "") : text;
    try { logMessage(from, "user", logText, mediaFields); } catch (e) {}
//deixa o texto sem espaços e em minúsculas para trabalhar com um padrão
    const stage = state.get(from) || "idle";

    /* CONTEXT RESCUE:
       Se por algum motivo o estado ficou desalinhado, mas o último menu enviado foi Ponto/Folha,
       e o usuário respondeu com um número válido, redireciona para o estado correto. */
    const ctx = lastMenuCtx.get(from);
    if (ctx && (Date.now() - (ctx.ts || 0)) < 5 * 60 * 1000) { // até 5 min
      if (ctx.menu === "ponto" && ["1","2","3","4","5","6","7","8","9"].includes(n) && stage === "await_main_choice") {
        state.set(from, "await_ponto_choice");
      }
      if (ctx.menu === "folha" && ["1","2","3","4","5"].includes(n) && stage === "await_main_choice") {
        state.set(from, "await_folha_choice");
      }
    } //Pega o estado atual da conversa desse número (guardado no Map state)

    // A cada nova mensagem recebida, o bot reinicia o temporizador de inatividade
    resetInactivityTimer(from);

  //------------------------------------------------------------------------------CONTROLE DE INICIO DE CONVERSA -----------------------------------------------------------------------


  /*Se o usuário é novo (idle) ou acabou de encerrar a conversa (ended), o bot:
    Manda a saudação + menu principal (sendWelcomeAndMenu(from));
    Atualiza o estado para "await_main_choice" (aguardando escolha do menu);
    Retorna 200 pro Meta pra confirmar que a mensagem foi processada.*/
    if (stage === "ended" || stage === "idle") {
      await sendWelcomeAndMenu(from);
      return res.sendStatus(200);
    }


    //------------------------------------------------------------------------------ COLETA DE NOME (INÍCIO DO ATENDIMENTO) -----------------------------------------------------------------------
    if (stage === "await_user_name") {
      const name = (text || "").toString().trim().replace(/\s+/g, " ");

      if (!isValidFullName(name)) {
        await sendText(from, "Por favor, envie seu *nome completo* (nome e sobrenome).");
        return res.sendStatus(200);
      }

      userNames.set(from, name);
      try { upsertContact(from, { name, phone: toDisplayPhone(from) }); } catch (e) {}

      await sendRootMenu(from);
      setState(from, "await_main_choice");
      return res.sendStatus(200);
    }





  //------------------------------------------------------------------------------ ENCAMINHAMENTO PARA ATENDIMENTO HUMANO (ASSUNTO) -----------------------------------------------------------------------
    if (stage === "await_human_topic") {
      const parsed = parseHumanTopic(n);
      if (!parsed) {
        await sendText(from, "Não consegui identificar o assunto.\n\n" + HUMAN_TOPIC_PROMPT);
        state.set(from, "await_human_topic");
        return res.sendStatus(200);
      }

      handoverTopics.set(from, parsed);
      upsertTopicToMongo(from, parsed).catch(() => {});

      const __pos = enqueueHandover(from);
      await sendText(from, handoverMsg(__pos));
      setState(from, "handover");
      stopInactivity(from);

      try {
        const position = __pos;
        await notifyRH({ from, position });
      } catch (err) {
        console.error("Falha ao notificar RH:", err?.message || err);
      }

      return res.sendStatus(200);
    }

//------------------------------------------------------------------------------ TRATATIVA DAS OPÇÕES DO MENU PRINCIPAL   -----------------------------------------------------------------------

    if (stage === "await_main_choice") { //Só entra aqui se o estado atual do usuário for “aguardando escolha do menu principal”.
      if (["1", "2", "3", "4"].includes(n)) { //Garante que a resposta seja uma das opções válidas
        //Envia os Submenus
        if (n === "1") {
          await sendPontoMenu(from);
          state.set(from, "await_ponto_choice");
} else if (n === "2") {
          // entrar no submenu Folha & Benefícios
          lastMenuCtx.set(from, { menu: "folha", ts: Date.now() });
          await sendText(from, FOLHA_MENU);
          state.set(from, "await_folha_choice");
        } else if (n === "3") {
          // Dúvidas sobre holerite
          // Etiqueta automática (assunto já conhecido)
          handoverTopics.set(from, { key: "holerite", label: "Holerite" });
          upsertTopicToMongo(from, { key: "holerite", label: "Holerite" }).catch(() => {});
          await sendText(from, "Por favor, escreva a sua dúvida sobre o holerite (em texto).");
          holeriteSessions.set(from, { hasText: false, hasImage: false, forwardTimer: null });
          state.set(from, "await_holerite_text");
        } else if (n === "4") {
          await beginHumanRouting(from);
          return res.sendStatus(200);
        }

        /*esse trecho é o tratamento de respostas inválidas, ou seja, 
        o que o bot faz quando o usuário manda algo que não corresponde a nenhuma opção esperada.*/
      } else {
        await sendText(from, "Não consegui identificar sua resposta.");
        await wait(1000);
        await sendRootMenu(from);
        state.set(from, "await_main_choice");
      }
      return res.sendStatus(200);//é o fechamento do endpoint /webhook, serve pra responder o WhatsApp (Meta) dizendo que o bot recebeu e processou a mensagem com sucesso.
    }
//---------------------------------------------------------------------------------------INTERAÇÃO OPÇÃO 3 MENU (HOLERITE) -----------------------------------------------------------
// Menu 3 (Holerite): passo 1 = texto da dúvida | passo 2 = print (imagem)

if (stage === "await_holerite_text") {
  const sess = holeriteSessions.get(from) || { hasText: false, hasImage: false, forwardTimer: null };
  const hasText = !!(msg.text?.body);
  const hasImage = !!(msg.image);

  if (hasText) {
    sess.hasText = true;
    holeriteSessions.set(from, sess);

    await sendText(from, "Perfeito. Agora, por favor, envie um print (imagem) do seu holerite.");
    state.set(from, "await_holerite_image");
    return res.sendStatus(200);
  }

  if (hasImage) {
    sess.hasImage = true;
    holeriteSessions.set(from, sess);

    await sendText(from, "Recebi o print. Agora, por favor, escreva a sua dúvida em texto.");
    state.set(from, "await_holerite_text");
    return res.sendStatus(200);
  }

  await sendText(from, "Por favor, escreva a sua dúvida sobre o holerite (em texto).");
  state.set(from, "await_holerite_text");
  return res.sendStatus(200);
}

if (stage === "await_holerite_image") {
  const sess = holeriteSessions.get(from) || { hasText: false, hasImage: false, forwardTimer: null };
  const hasText = !!(msg.text?.body);
  const hasImage = !!(msg.image);

  if (hasText && !hasImage) {
    sess.hasText = true;
    holeriteSessions.set(from, sess);
    await sendText(from, "Entendi. Agora, por favor, envie um print (imagem) do seu holerite.");
    state.set(from, "await_holerite_image");
    return res.sendStatus(200);
  }

  if (hasImage) {
    sess.hasImage = true;
    holeriteSessions.set(from, sess);

    if (!sess.hasText) {
      await sendText(from, "Recebi o print. Agora, por favor, escreva a sua dúvida em texto.");
      state.set(from, "await_holerite_text");
      return res.sendStatus(200);
    }

    await sendText(from, "Recebi sua mensagem e o print. Vou te direcionar ao atendimento humano.");
    state.set(from, "await_holerite_forward");
    armHoleriteForward(from);
    return res.sendStatus(200);
  }

  await sendText(from, "Por favor, envie um print (imagem) do seu holerite.");
  state.set(from, "await_holerite_image");
  return res.sendStatus(200);
}

if (stage === "await_holerite_forward") {
  await sendText(from, "Ok. Já estou te direcionando ao atendimento humano.");
  return res.sendStatus(200);
}


//------------------------------------------------------------------------------ TRATATIVA DAS OPÇÕES DO SUBMENU 1 PONTO   -----------------------------------------------------------------------

    if (stage === "await_ponto_choice") {
      // opções válidas: 1..9
      if (["1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(n)) {

        // 9 = retornar ao menu inicial
        if (n === "9") {
          removeFromQueue(from);
          await sendRootMenu(from);
          state.set(from, "await_main_choice");
          return res.sendStatus(200);
        }

        // 8 = falar com atendente (handover)
        if (n === "8") {
          await beginHumanRouting(from);
          return res.sendStatus(200);
        }

        // 1..7 = passo a passo
        const map = {
          "1": PASSO_REGISTRAR,
          "2": PASSO_ESPELHO,
          "3": PASSO_ABONO,
          "4": PASSO_CANCELAR_BATIDA,
          "5": PASSO_INCLUIR,
          "6": PASSO_ATESTADO,
          "7": PASSO_APROVACAO_ESPELHO,
        };

        await sendText(from, map[n]);
        await wait(1000);
        await sendText(from, ASK_BACK);
        state.set(from, "await_back_menu");
        return res.sendStatus(200);

      } else {
        await sendText(from, "Não consegui identificar sua resposta.");
        await wait(1000);
        await sendPontoMenu(from);
        state.set(from, "await_ponto_choice");
        return res.sendStatus(200);
      }
    }

    //------------------------------------------------------------------------------ TRATATIVA DAS OPÇÕES DO SUBMENU 2 (FOLHA E BENEFÍCIOS)  -----------------------------------------------------------------------

    if (stage === "await_folha_choice") {
      if (["1", "2", "3", "4", "5"].includes(n)) { //Garante que a resposta seja uma das opções do submenu.
        if (n === "5") {
          // retornar ao menu inicial
          removeFromQueue(from); // garante limpeza do usuário na lista de chamados, se estava em fila
          await sendRootMenu(from); //Reenvia o menu principal e volta o estado para await_main_choice.
          state.set(from, "await_main_choice");
          return res.sendStatus(200);
        }
        if (n === "4") {
          await beginHumanRouting(from);
          return res.sendStatus(200);
        }
        /* Envia o conteúdo correspondente aos textos já prontos: atestado, histórico de pagamentos, etc.*/
        const map = {
          "1": PASSO_HIST_PAGAMENTOS,
          "2": PASSO_HIST_SALARIAL,
          "3": PASSO_INFORME,
        };

//------------------------------------------------------------------------------ RETORNA AO MENU INICIAL  -----------------------------------------------------------------------

        //Depois de 1s, pergunta “Deseja voltar ao Menu Inicial? 
        await sendText(from, map[n]);
        await wait(1000); // espera 1s
        await sendText(from, ASK_BACK);
        state.set(from, "await_back_menu");
      } else { // se o usuários da uma resposta inválida
        await sendText(from, "Não consegui identificar sua resposta.");
        await wait(1000);// espera 1s
        lastMenuCtx.set(from, { menu: "folha", ts: Date.now() });
          lastMenuCtx.set(from, { menu: "folha", ts: Date.now() });
        await sendText(from, FOLHA_MENU);//envia novamente o menu
        state.set(from, "await_folha_choice");
      }
      return res.sendStatus(200);
    }

    if (stage === "await_back_menu") {
      if (["sim", "s"].includes(n)) { // Se a resposta do usuário for sim
        removeFromQueue(from); //Remove ele da fila de chamados caso ele esteja
        await sendRootMenu(from);//Reenvia o menu inicial sem saldação
        state.set(from, "await_main_choice");

      } else if (["nao", "não", "n"].includes(n)) {// Se o usuário responde não
        await sendText(from, THANKS);// Envia mensagem de agradecimento e encerra o atendimento
        removeFromQueue(from); // Remove o usuário da fila de chamados pois o atendimento encerrou
        setState(from, "ended");// encerra o atendimento; próxima mensagem reinicia o bot com saudação+menu

      } else {//caso o usuário envie uma esposta errada
        await sendText(from, 'Não consegui identificar. Responda com "sim" ou "não".'); 
        await wait(1000); //espera 1s
        await sendText(from, ASK_BACK); //reenvia a mensagem de voltar ao menu
        state.set(from, "await_back_menu");
      }
      return res.sendStatus(200);
    }

//------------------------------------------------------------------------------ BOT EM ESTADO HANOVER (DORMINDO)  -----------------------------------------------------------------------

    // Se o usuário  manda mensagem estando no estado Hanover o bot oferece algumas opções de saída

    // Se o atendimento humano estiver ativo via painel (/admin), o bot não responde
    if (stage === "manual") {
      return res.sendStatus(200);
    }

    if (stage === "handover") {
      await sendText(from, ASK_HANDOVER); // envia  o menu com as duas opções
      state.set(from, "await_handover_choice"); // entra em estado de espera da resposta com a escolha
      return res.sendStatus(200);
    }

    // se o bot está em estado de espera, aguardando a escolha
    if (stage === "await_handover_choice") {
      if (n === "1") { //e se a resposta do usuário for 1
        removeFromQueue(from); // Ele remove o usuário da fila de chamados 
        //retoma o fluxo do bot 
        await sendRootMenu(from);
        state.set(from, "await_main_choice");
        return res.sendStatus(200);

      } else if (n === "2") {//e se a resposta do usuário for 1
        // o Bot reenvia a mensagem de encaminhameneto 
        const __pos = enqueueHandover(from);
    await sendText(from, handoverMsg(__pos));
        setState(from, "handover");// e retorna para o estado "Dormindo"
        stopInactivity(from); // mantém regra de não encerrar por inatividade no handover

        // Garante o a posição do usuário na fila e garante que o RH foi avisado 
        try {
          const position = enqueueHandover(from);
          await notifyRH({ from, position });
        } catch (err) {
          console.error("Falha ao notificar RH:", err?.message || err);
        }

        return res.sendStatus(200);
      } else { // Itentific uma resposta inválida e reenvia a pergunta
        await sendText(from, "Não consegui identificar sua resposta. Por favor, escolha uma das opções.");
        await sendText(from, ASK_HANDOVER);
        return res.sendStatus(200);
      }
    }

    // verificação de segurança, volta para o menu principal (sem saudação)
    removeFromQueue(from); // Limpa qualquer resíduo na fila de chamados
    await sendRootMenu(from);
    state.set(from, "await_main_choice");
    return res.sendStatus(200);
  } catch (e) {
    console.error("Erro no webhook:", e?.response?.data || e.message);
    return res.sendStatus(200);
  }
});

//------------------------------------------------------------------------------ TESTE DE VERIFICAÇÃO DE CONEXÃO COM O EMAIL  -----------------------------------------------------------------------


//------------------------------------------------------------------------------ TESTE DE ENVIO DE MENSAGEM (TEMPLATE)  -----------------------------------------------------------------------
// Use este endpoint para FAZER A PRIMEIRA MENSAGEM chegar no seu número de teste (inicia a conversa via template).
// Você pode passar ?to=5511999999999 (somente números) para testar outro destino autorizado.
app.get("/test-message", async (req, res) => {
  const raw = (req.query.to || process.env.TEST_NUMBER || "5500000000000").toString();
  const to = raw.replace(/\D/g, ""); // deixa só dígitos (DDI+DDD+NÚMERO)
  try {
    console.log("Enviando TEMPLATE hello_world para:", to);
    const r = await sendHelloWorldTemplate(to);
    console.log("✅ WhatsApp API response:", r.data);
    return res.status(200).send("✅ Mensagem TEMPLATE (hello_world) enviada. Verifique o WhatsApp e os logs.");
  } catch (e) {
    console.error("❌ Erro ao enviar TEMPLATE:", e?.response?.data || e.message);
    return res.status(500).send("❌ Falha ao enviar TEMPLATE. Veja logs do Koyeb.");
  }
});

app.get("/test-email", async (req, res) => { //Cria uma rota GET /test-email para disparar um envio de teste via Nodemailer.
  try {
    const info = await mailer.sendMail({//Usa o transporter mailer JA CRIADO para enviar e-mail.
      from: `BOT RH <${process.env.SMTP_USER}>`,//mostra “BOT RH” com o remetente do .env
      to: process.env.NOTIFY_TO || process.env.SMTP_USER, //manda para NOTIFY_TO se existir; senão, vai para o próprio SMTP_USER.
      //Mensagem
      subject: "Teste de envio (Nodemailer)",
      text: "Olá! Este é um teste de envio via Nodemailer.",
      html: "<p>Olá! Este é um <b>teste</b> de envio via Nodemailer.</p>",
    });
    return res.status(200).send(`✅ Email enviado! MessageId: ${info.messageId || "(n/a)"}`); //Se deu certo, retorna 200 com o messageId.
  } catch (err) {//Se der erro, cai no catch.
    console.error("Falha ao enviar email:", err);
    return res.status(500).send(`❌ Erro ao enviar: ${err?.response || err?.message || err}`);
  }
});

//------------------------------------------------------------------------------ FINALIZA O CICLO PRINCIPAL DO BOT  -----------------------------------------------------------------------

app.get("/", (req, res) => res.send("Servidor do Bot RH ativo!"));//rota raiz: confirma que o servidor está ativo

app.get("/healthz", (req, res) => res.status(200).send("ok"));// rota de healthcheck (para serviços de hospedagem monitorarem)




// ====================================================================================== PAINEL ADMIN (/admin) ============================================================================

/*função que recebe o numero de telefone e deixa ele com uma estrutura visual melhor
recebe o numero cru (5511987654321) e devolve corrigido (+55 11 98765-4321)*/

function toDisplayPhone(waId) {
  const s = (waId || "").toString().trim();
  if (s.startsWith("55") && s.length >= 12) {
    const ddd = s.slice(2,4);
    const num = s.slice(4);
    if (num.length === 9) return `+55 ${ddd} ${num.slice(0,5)}-${num.slice(5)}`;
    if (num.length === 8) return `+55 ${ddd} ${num.slice(0,4)}-${num.slice(4)}`;
    return `+55 ${ddd} ${num}`;
  }
  return s ? `+${s}` : "";
}

//o painel é “uma página de site” dentro do código
function adminHTML() {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>BOOT RH — Admin</title>
<style>
:root{
  --bg:#111b21;--panel:#202c33;--panel2:#2a3942;--panel3:#1f2c34;
  --text:#e9edef;--muted:#8696a0;--accent:#00a884;--accent2:#005c4b;
  --danger:#ef4444;--warn:#f0a500;--border:rgba(134,150,160,.15);
  --bubble-in:#202c33;--bubble-out:#005c4b;--bubble-human:#1f2937;
  --header:#202c33;--sidebar:#111b21;--search-bg:#2a3942;
  --item-hover:#2a3942;--item-active:#2a3942;
  --pill-bg:rgba(134,150,160,.12);
  --radius-bubble:8px;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;overflow:hidden;}

/* ─── HEADER ─────────────────────────────────────── */
header{
  height:60px;min-height:60px;
  padding:0 16px;background:var(--header);
  border-bottom:1px solid var(--border);
  display:flex;justify-content:space-between;align-items:center;
  flex-shrink:0;
}
header .logo{display:flex;align-items:center;gap:10px;}
header .logo-icon{width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
header .logo-text{font-weight:700;font-size:15px;line-height:1.2;}
header .logo-sub{font-size:11px;color:var(--muted);}
header .header-right{display:flex;align-items:center;gap:10px;}
.small{color:var(--muted);font-size:12px;}

/* ─── LAYOUT ─────────────────────────────────────── */
.wrap{flex:1;display:grid;grid-template-columns:minmax(320px,30%) 1fr;min-height:0;overflow:hidden;}

/* ─── SIDEBAR ────────────────────────────────────── */
.sidebar{background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0;overflow:hidden;}
.search{padding:8px 12px;background:var(--sidebar);flex-shrink:0;}
.search input{
  width:100%;padding:9px 14px 9px 38px;border-radius:8px;border:none;
  background:var(--search-bg);color:var(--text);outline:none;font-size:14px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%238696a0' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.099zm-5.44 1.406a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:12px center;
}
.search input::placeholder{color:var(--muted);}
.list{flex:1;overflow-y:auto;overflow-x:hidden;}
.list::-webkit-scrollbar{width:6px;}
.list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px;}

/* ─── TABS ───────────────────────────────────────── */
.tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0;}
.tab{
  flex:1;background:transparent;border:none;border-bottom:2px solid transparent;
  color:var(--muted);padding:10px 4px;cursor:pointer;font-size:12px;font-weight:500;
  transition:color .15s,border-color .15s;
}
.tab.active{border-bottom-color:var(--accent);color:var(--accent);}
.tab:hover:not(.active){color:var(--text);}

/* ─── CONVERSA ITEM ──────────────────────────────── */
.item{
  padding:12px 16px;border-bottom:1px solid var(--border);
  cursor:pointer;user-select:none;transition:background .1s;
  display:flex;align-items:center;gap:12px;
}
.item *{pointer-events:none;}
.item:hover{background:var(--item-hover);}
.item.active{background:var(--item-active);}
.item-avatar{
  width:49px;height:49px;border-radius:50%;flex-shrink:0;
  background:var(--panel2);display:flex;align-items:center;justify-content:center;
  font-size:20px;font-weight:700;color:var(--muted);
}
.item-avatar.blocked-av{background:rgba(239,68,68,.15);color:#ef4444;}
.item-body{flex:1;min-width:0;}
.item-row1{display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-bottom:3px;}
.name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}
.item-time{font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0;}
.item-row2{display:flex;justify-content:space-between;align-items:center;gap:6px;}
.item-preview{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}
.unread{min-width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:var(--accent);color:#062f27;font-weight:700;font-size:11px;padding:0 5px;flex-shrink:0;}
.pill{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--pill-bg);color:var(--muted);white-space:nowrap;}
.pill.green{color:var(--accent);background:rgba(0,168,132,.12);}
.pill.yellow{color:var(--warn);background:rgba(240,165,0,.12);}
.pill.red{color:#ef4444;background:rgba(239,68,68,.12);}
.pill.gray{color:var(--muted);background:var(--pill-bg);}
.pill.blue{color:#60a5fa;background:rgba(96,165,250,.12);}
.pill.topic{font-size:10px;}
.pill.topic.blue{background:rgba(60,145,255,.14);border:1px solid rgba(60,145,255,.3);color:rgba(200,225,255,.95);}
.pill.topic.purple{background:rgba(170,90,255,.14);border:1px solid rgba(170,90,255,.3);color:rgba(230,210,255,.95);}
.pill.topic.teal{background:rgba(0,200,180,.14);border:1px solid rgba(0,200,180,.3);color:rgba(200,255,245,.95);}
.pill.topic.orange{background:rgba(255,170,0,.14);border:1px solid rgba(255,170,0,.3);color:rgba(255,235,200,.95);}
.pill.topic.red{background:rgba(255,80,80,.14);border:1px solid rgba(255,80,80,.3);color:rgba(255,210,210,.95);}

/* ─── MAIN CHAT ──────────────────────────────────── */
main{display:flex;flex-direction:column;min-height:0;background:var(--bg);position:relative;}
/* fundo liso */

.chatHeader{
  padding:10px 16px;background:var(--header);border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:12px;flex-shrink:0;min-height:60px;z-index:1;
}
.chatHeader-avatar{width:40px;height:40px;border-radius:50%;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;color:var(--muted);flex-shrink:0;}
.chatHeader-info{flex:1;min-width:0;}
.chatHeader-name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chatHeader-sub{font-size:12px;color:var(--muted);}
.actions{display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0;}
button{padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);cursor:pointer;font-size:13px;transition:background .15s;}
button:hover{background:rgba(255,255,255,.06);}
button.primary{background:rgba(0,168,132,.15);border-color:rgba(0,168,132,.4);color:var(--accent);}
button.primary:hover{background:rgba(0,168,132,.25);}
button.danger{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);color:#ef4444;}
button.danger:hover{background:rgba(239,68,68,.22);}
button.warn{background:rgba(240,165,0,.12);border-color:rgba(240,165,0,.35);color:var(--warn);}
button.warn:hover{background:rgba(240,165,0,.22);}

/* ─── MENSAGENS ──────────────────────────────────── */
.messages{flex:1;overflow-y:auto;padding:16px 10%;display:flex;flex-direction:column;gap:4px;z-index:1;}
.messages::-webkit-scrollbar{width:6px;}
.messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:3px;}
.bubble{
  max-width:65%;padding:7px 10px 20px;border-radius:var(--radius-bubble);
  white-space:pre-wrap;word-break:break-word;position:relative;font-size:14px;line-height:1.4;
}
.bubble.in{align-self:flex-start;background:var(--bubble-in);border-top-left-radius:0;}
.bubble.out{align-self:flex-end;background:var(--bubble-out);border-top-right-radius:0;}
.bubble.human{align-self:flex-end;background:var(--bubble-human);border-top-right-radius:0;border:1px solid rgba(255,255,255,.08);}
.ts{position:absolute;bottom:5px;right:9px;font-size:10px;color:rgba(233,237,239,.6);white-space:nowrap;}
.bubble-label{font-size:10px;font-weight:600;margin-bottom:3px;opacity:.7;}
.bubble.in .bubble-label{color:var(--accent);}
.bubble.out .bubble-label{color:rgba(255,255,255,.5);}
.bubble.human .bubble-label{color:#93c5fd;}
.bubble-text{word-break:break-word;white-space:pre-wrap;}

/* ─── MÍDIA ──────────────────────────────────────── */
.media-wrap{display:flex;flex-direction:column;gap:6px;margin:4px 0;}
.media-img{max-width:260px;max-height:260px;border-radius:8px;cursor:pointer;object-fit:cover;border:1px solid rgba(255,255,255,.1);}
.media-video{max-width:260px;border-radius:8px;outline:none;}
.media-audio{width:220px;height:36px;border-radius:20px;}
.media-sticker{width:120px;height:120px;object-fit:contain;}
.media-doc{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.06);border-radius:10px;padding:10px 14px;border:1px solid rgba(255,255,255,.08);}
.media-doc-icon{font-size:28px;flex-shrink:0;}
.media-doc-name{font-size:13px;color:var(--text);word-break:break-all;flex:1;}
.media-dl{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--accent);text-decoration:none;padding:4px 10px;border-radius:20px;background:rgba(0,168,132,.12);border:1px solid rgba(0,168,132,.25);width:fit-content;transition:background .15s;}
.media-dl:hover{background:rgba(0,168,132,.25);}

.date-divider{align-self:center;font-size:12px;color:var(--muted);background:rgba(17,27,33,.85);padding:5px 14px;border-radius:8px;margin:8px 0;border:1px solid var(--border);}
.empty{padding:32px;color:var(--muted);text-align:center;font-size:14px;}

/* ─── COMPOSER ───────────────────────────────────── */
.composer{
  padding:10px 14px;border-top:1px solid var(--border);
  display:flex;flex-direction:column;gap:8px;background:var(--panel3);flex-shrink:0;z-index:1;
}
.composer-row{display:flex;gap:8px;align-items:flex-end;}
.composer textarea{
  flex:1;resize:none;min-height:44px;max-height:140px;padding:11px 14px;
  border-radius:10px;border:none;background:var(--search-bg);color:var(--text);
  outline:none;font-size:14px;line-height:1.4;
}
.composer textarea::placeholder{color:var(--muted);}
.attach-preview{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:var(--search-bg);font-size:13px;color:var(--muted);}
.attach-preview .ap-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.btn-attach{width:44px;height:44px;border-radius:50%;border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.btn-attach:hover{color:var(--text);background:rgba(255,255,255,.06);}
.btn-send{width:44px;height:44px;border-radius:50%;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.btn-send:hover{background:#00c49a;}

/* ─── MODAIS ─────────────────────────────────────── */
.modal-backdrop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);z-index:9999;backdrop-filter:blur(2px);}
.modal-box{width:min(480px,92vw);background:var(--panel);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);padding:20px;}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
.modal-title{font-weight:700;font-size:16px;}
.modal-close{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:20px;padding:4px;}
.modal-close:hover{color:var(--text);}
.field-label{font-size:12px;color:var(--muted);margin-bottom:6px;}
.field-input{width:100%;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--search-bg);color:var(--text);outline:none;font-size:14px;}
.field-input:focus{border-color:rgba(0,168,132,.5);}
.field-input:disabled{opacity:.6;}
.field-grid{display:grid;gap:12px;}
.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}
.modal-warn{font-size:12px;color:var(--muted);background:rgba(240,165,0,.08);border:1px solid rgba(240,165,0,.2);border-radius:8px;padding:8px 12px;margin-bottom:4px;}
.error-text{color:#ef4444;font-size:13px;display:none;margin-top:4px;}

/* ─── BOTÃO INICIAR CONVERSA ─────────────────────── */
.meta-warning-badge{
  display:inline-flex;align-items:center;gap:6px;padding:6px 12px;
  border-radius:20px;border:1px solid rgba(255,180,0,.35);
  background:rgba(255,180,0,.1);color:#f0b429;
  font-size:12px;font-weight:500;cursor:default;user-select:none;
}

/* ─── EMPTY STATE ────────────────────────────────── */
.chat-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--muted);z-index:1;}
.chat-empty-icon{font-size:64px;opacity:.3;}
.chat-empty-text{font-size:16px;font-weight:500;}
.chat-empty-sub{font-size:13px;opacity:.7;}

/* ─── BLOCKED BANNER ─────────────────────────────── */
.blocked-banner{
  margin:8px 10%;padding:10px 16px;border-radius:8px;
  background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);
  color:#ef4444;font-size:13px;text-align:center;z-index:1;
}
</style>
</head>
<body>
<header>
  <div class="logo">
    <div class="logo-icon">💼</div>
    <div>
      <div class="logo-text">RH — Painel</div>
      <div class="logo-sub" id="conn" style="color:#00a884;">● Online</div>
    </div>
  </div>
  <div class="header-right">
    <div class="small" style="text-align:right;">Atualizado: ${BUILD_LABEL}</div>
    <div class="meta-warning-badge" title="Mensagens iniciadas pelo RH fora da janela de 24h podem ser cobradas pela Meta.">⚠️ Mensagens fora da janela de 24h podem gerar cobrança pela Meta</div>
  </div>
</header>

<div class="wrap">
  <aside class="sidebar">
    <div class="search">
      <input id="q" placeholder="Pesquisar ou começar uma nova conversa"/>
    </div>
    <div class="tabs" id="tabs">
      <button class="tab active" data-tab="queue">Na fila</button>
      <button class="tab" data-tab="manual">Atendimento</button>
      <button class="tab" data-tab="ended">Encerrados</button>
      <button class="tab" data-tab="contacts">Contatos</button>
    </div>
    <div style="padding:6px 12px;display:none;" id="newContactRow">
      <button id="btnNewContact" style="width:100%;justify-content:center;display:flex;gap:6px;">＋ Novo contato</button>
    </div>
    <div class="list" id="list"></div>
  </aside>

  <main>
    <div class="chatHeader" id="chatHeader">
      <div class="chatHeader-avatar" id="chatHeaderAvatar">💬</div>
      <div class="chatHeader-info">
        <div class="chatHeader-name" id="contactName">Selecione uma conversa</div>
        <div class="chatHeader-sub small" id="contactSub">Nenhuma conversa aberta</div>
      </div>
      <div class="actions" id="actions" style="display:none;">
        <button class="primary" id="btnAssume">▶ Assumir</button>
        <button class="danger" id="btnEnd">✕ Encerrar</button>
        <button id="btnStartConv" title="Iniciar conversa (template)" style="background:var(--accent,#25d366);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;">📨 Iniciar</button>
        <button id="btnEditContact" title="Editar contato">✏️</button>
        <button class="danger" id="btnBlock" title="Bloquear contato">🚫</button>
      </div>
    </div>

    <div id="blockedBanner" class="blocked-banner" style="display:none;">🚫 Este contato está bloqueado — não receberá respostas do bot.</div>

    <div class="messages" id="messages">
      <div class="chat-empty">
        <div class="chat-empty-icon">💬</div>
        <div class="chat-empty-text">Painel RH</div>
        <div class="chat-empty-sub">Selecione uma conversa para começar</div>
      </div>
    </div>

    <div class="composer" id="composer" style="display:none;">
      <div id="attachPreview" style="display:none;" class="attach-preview">
        <span>📎</span>
        <span id="attachName" class="ap-name"></span>
        <button onclick="clearAttach()" style="padding:3px 8px;font-size:12px;">✕</button>
      </div>
      <div class="composer-row">
        <input type="file" id="fileInput" style="display:none;" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.csv"/>
        <button class="btn-attach" id="btnAttach" title="Enviar arquivo">📎</button>
        <textarea id="text" placeholder="Digite uma mensagem…" rows="1"></textarea>
        <button class="btn-send" id="btnSend" title="Enviar">➤</button>
      </div>
    </div>
  </main>
</div>


<!-- Modal de Iniciar Conversa -->
<div id="startModal" class="modal-backdrop">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title">Iniciar conversa</div>
      <button class="modal-close" id="smClose">✕</button>
    </div>
    <div id="smContactName" style="font-weight:600;font-size:15px;padding:4px 0 2px;"></div>
    <div class="modal-warn">⚠️ Isso envia um template WhatsApp. Se o contato não respondeu nas últimas 24h, pode gerar cobrança pela Meta.</div>
    <div class="field-grid">
      <div>
        <input id="smWaId" type="hidden"/>
      </div>
      <div>
        <div class="field-label">Template</div>
        <input id="smTemplate" class="field-input" placeholder="avisos_rh"/>
      </div>
      <div>
        <div class="field-label">Idioma do template</div>
        <input id="smLang" class="field-input" placeholder="pt_BR"/>
      </div>
      <div id="smError" class="error-text"></div>
    </div>
    <div class="modal-actions">
      <button class="primary" id="smSend">Enviar template</button>
    </div>
  </div>
</div>

<!-- Modal de Contato -->
<div id="contactModal" class="modal-backdrop">
  <div class="modal-box">
    <div class="modal-header">
      <div class="modal-title" id="cmTitle">Contato</div>
      <button class="modal-close" id="cmClose">✕</button>
    </div>
    <div class="small" style="margin-bottom:12px;color:var(--muted);">O <b>WaId</b> é o identificador real do WhatsApp. O telefone editado aqui é apenas para exibição.</div>
    <div class="field-grid">
      <div>
        <div class="field-label">WaId (não editável)</div>
        <input id="cmWaId" class="field-input" disabled/>
      </div>
      <div>
        <div class="field-label">Nome</div>
        <input id="cmName" class="field-input" placeholder="Nome e sobrenome"/>
      </div>
      <div>
        <div class="field-label">Telefone (exibição)</div>
        <input id="cmPhone" class="field-input" placeholder="+55 11 9xxxx-xxxx"/>
      </div>
    </div>
    <div class="modal-actions">
      <button class="danger" id="cmDelete" style="display:none;">Apagar contato</button>
      <button class="primary" id="cmSave">Salvar</button>
    </div>
  </div>
</div>

<script>
const $=(id)=>document.getElementById(id);
let allConvos=[]; let allContacts=[]; let activeId=null; let activeData=null; let activeIsContact=false; let openSeq=0; const convCache=new Map();

function fmtTS(iso){ try{ const d=new Date(iso); return d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }
function fmtDate(iso){ try{ return new Date(iso).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}); }catch(e){ return ''; } }
function fmtFull(iso){ try{ return new Date(iso).toLocaleString('pt-BR'); }catch(e){ return ''; } }
function displayName(c){ return (c.name||'').toString().trim(); }
function displayPhone(c){ return (c.displayPhone||('+'+(c.waId||''))).toString().trim(); }
function displayTitle(c){ const nm=displayName(c); const ph=displayPhone(c); return nm ? (nm+' — '+ph) : ph; }
function avatarLetter(c){ const n=displayName(c)||displayPhone(c); return (n||'?')[0].toUpperCase(); }

function getContactById(id){
  return (allContacts||[]).find(c=>String(c.waId||'')===String(id||'')) || null;
}

function statusOf(c){
  if(c.blocked) return {label:'Bloqueado', cls:'red'};
  if(c.state==='ended') return {label:'Encerrado', cls:'gray'};
  if(c.inQueue || c.state==='handover') {
    const pos = Number(c.queuePos||0);
    return {label:('Na fila ' + (pos?('#'+pos):'')).trim(), cls:'yellow'};
  }
  if(c.state==='manual') return {label:'Em atendimento', cls:'green'};
  return {label:'Robô ativo', cls:'blue'};
}
function topicOf(c){
  const t=c.topic;
  if(!t || !t.key) return null;
  const map={beneficios:'blue',ponto:'purple',folha:'teal',holerite:'teal',ferias:'orange',rescisao:'red',consignado:'blue'};
  return {label:(t.label||'').toString(), cls:'topic '+(map[t.key]||'')};
}

function updateTabBadges(){
  try{
    const tabsEl = document.getElementById('tabs');
    if(!tabsEl) return;
    const queueCount = allConvos.filter(c => !c.blocked && (c.inQueue || c.state==='handover')).length;
    const inProgressCount = allConvos.filter(c => {
      if(c.blocked) return false;
      const isQueue = (c.inQueue || c.state==='handover');
      const isEnded = (c.state==='ended');
      const isManual = (c.state==='manual');
      const isRobot = (!isEnded && !isQueue && !isManual);
      return (isManual || isRobot);
    }).length;
    const btnQueue = tabsEl.querySelector('[data-tab="queue"]');
    const btnManual = tabsEl.querySelector('[data-tab="manual"]');
    if(btnQueue) btnQueue.innerHTML = 'Na fila' + (queueCount>0 ? (' <span class="unread">'+queueCount+'</span>') : '');
    if(btnManual) btnManual.innerHTML = 'Atendimento' + (inProgressCount>0 ? (' <span class="unread">'+inProgressCount+'</span>') : '');
  }catch(e){}
}

// Gera o innerHTML de um item de conversa
function _convItemHTML(c) {
  const st=statusOf(c);
  const unread=Number(c.unread||0);
  const lastMsg = c.lastMessageAt ? fmtTS(c.lastMessageAt) : '';
  const tp=topicOf(c);
  return '<div class="item-avatar'+(c.blocked?' blocked-av':'')+'">'+avatarLetter(c)+'</div>'
    +'<div class="item-body">'
    +  '<div class="item-row1"><span class="name">'+(displayName(c)||displayPhone(c))+'</span><span class="item-time">'+lastMsg+'</span></div>'
    +  '<div class="item-row2">'
    +    '<span class="item-preview">'+(displayName(c)?displayPhone(c):'')+'</span>'
    +    '<span class="pill '+st.cls+'">'+st.label+'</span>'
    +    (tp?('<span class="pill '+tp.cls+'">'+tp.label+'</span>'):'')
    +    (unread>0?'<span class="unread">'+unread+'</span>':'')
    +  '</div>'
    +'</div>';
}

// Gera o innerHTML de um item de contato
function _contactItemHTML(c, convo) {
  const unread = Number(convo?.unread||0);
  const isBlocked = convo?.blocked || false;
  const waId = String(c.waId||'');
  return '<div class="item-avatar'+(isBlocked?' blocked-av':'')+'">'+avatarLetter(c)+'</div>'
    +'<div class="item-body">'
    +  '<div class="item-row1"><span class="name">'+(c.name||c.displayPhone||('+'+waId))+'</span>'+(unread>0?'<span class="unread">'+unread+'</span>':'')+'</div>'
    +  '<div class="item-row2"><span class="item-preview">'+(c.displayPhone||('+'+waId))+'</span>'+(isBlocked?'<span class="pill red">Bloqueado</span>':'<span class="pill">Contato</span>')+'</div>'
    +'</div>';
}

function renderList(){
  updateTabBadges();
  const currentTab=(window.__currentTab||'queue');
  const ncRow=$('newContactRow');
  if(ncRow) ncRow.style.display = (currentTab==='contacts') ? 'block' : 'none';
  const q=($('q').value||'').toLowerCase().trim();
  const list=$('list');

  if(currentTab==='contacts'){
    const filteredC=(allContacts||[]).filter(c=>{
      if(!q) return true;
      return String(c.name||'').toLowerCase().includes(q) || String(c.displayPhone||'').toLowerCase().includes(q) || String(c.waId||'').includes(q);
    }).sort((a,b)=> String(a.name||'').toLowerCase().localeCompare(String(b.name||'').toLowerCase()));

    if(!filteredC.length){ list.innerHTML='<div class="empty">Sem contatos.</div>'; return; }

    // Patch: atualizar só o que mudou
    const existingIds = new Set();
    list.querySelectorAll('.item[data-kind="contact"]').forEach(el => existingIds.add(el.dataset.id));
    const newIds = new Set(filteredC.map(c => String(c.waId||'')));

    // Remover itens que saíram
    existingIds.forEach(id => { if(!newIds.has(id)) list.querySelector('.item[data-id="'+id+'"][data-kind="contact"]')?.remove(); });

    filteredC.forEach((c, idx) => {
      const waId = String(c.waId||'');
      const convo = (allConvos||[]).find(x=>x.waId===waId) || null;
      const newHTML = _contactItemHTML(c, convo);
      let el = list.querySelector('.item[data-id="'+waId+'"][data-kind="contact"]');
      if(!el){
        el = document.createElement('div');
        el.className='item'+(waId===activeId?' active':'');
        el.tabIndex=0; el.dataset.id=waId; el.dataset.kind='contact';
        list.appendChild(el);
      }
      if(el.innerHTML !== newHTML) el.innerHTML = newHTML;
      el.className='item'+(waId===activeId?' active':'');
    });
    return;
  }

  const filtered=allConvos.filter(c=>{
    if(currentTab==='queue'){
      if(c.blocked) return false;
      if(!(c.inQueue || c.state==='handover')) return false;
    } else if(currentTab==='manual'){
      if(c.blocked) return false;
      const isQueue = (c.inQueue || c.state==='handover');
      const isEnded = (c.state==='ended');
      const isManual = (c.state==='manual');
      const isRobot = (!isEnded && !isQueue && !isManual);
      if(!(isManual || isRobot)) return false;
    } else if(currentTab==='ended'){
      if(!c.blocked && c.state!=='ended') return false;
    }
    if(!q) return true;
    return String(c.name||'').toLowerCase().includes(q) || String(c.displayPhone||'').toLowerCase().includes(q) || String(c.waId||'').includes(q);
  }).sort((a,b)=>{
    const ta=String(a.lastMessageAt||''); const tb=String(b.lastMessageAt||'');
    return tb.localeCompare(ta) || String(a.waId||'').localeCompare(String(b.waId||''));
  });

  if(!filtered.length){ list.innerHTML='<div class="empty">Sem conversas.</div>'; return; }

  // Patch: atualizar só o que mudou, sem recriar o DOM inteiro
  const existingIds = new Set();
  list.querySelectorAll('.item[data-id]').forEach(el => existingIds.add(el.dataset.id));
  const newIds = new Set(filtered.map(c => c.waId));

  // Remover itens que saíram da aba
  existingIds.forEach(id => { if(!newIds.has(id)) list.querySelector('.item[data-id="'+id+'"]')?.remove(); });

  // Atualizar ou inserir na ordem correta
  filtered.forEach((c, idx) => {
    const newHTML = _convItemHTML(c);
    let el = list.querySelector('.item[data-id="'+c.waId+'"]');
    if(!el){
      el = document.createElement('div');
      el.tabIndex=0; el.dataset.id=c.waId;
      list.appendChild(el);
    }
    // Só atualiza innerHTML se mudou (evita piscar)
    if(el.innerHTML !== newHTML) el.innerHTML = newHTML;
    el.className='item'+(c.waId===activeId?' active':'');

    // Garantir ordem correta na lista
    const currentAtIndex = list.children[idx];
    if(currentAtIndex !== el) list.insertBefore(el, currentAtIndex||null);
  });
}

// Clique na lista
(function bindListDelegation(){
  const listEl = document.getElementById('list');
  if(!listEl) return;
  if(listEl.__bound) return;
  listEl.__bound = true;
  const openFromEvent = (e)=>{
    const item = e.target && e.target.closest ? e.target.closest('.item') : null;
    if(!item) return;
    const id = item.dataset && item.dataset.id;
    if(!id) return;
    e.preventDefault(); e.stopPropagation();
    openConversation(id);
  };
  listEl.addEventListener('pointerdown', openFromEvent, {capture:true});
  listEl.addEventListener('click', openFromEvent, {capture:true});
  listEl.addEventListener('keydown', (e)=>{
    if(e.key!=='Enter' && e.key!==' ') return;
    const item = e.target && e.target.closest ? e.target.closest('.item') : null;
    if(!item) return;
    const id = item.dataset && item.dataset.id;
    if(!id) return;
    e.preventDefault(); openConversation(id);
  });
})();

async function fetchConversations(force){
  const r=await fetch('/admin/api/conversations');
  const data=await r.json();
  allConvos=data.conversations||[];
  const fp = _listFingerprint();
  const hasQuery = !!($('q')&&$('q').value||'').trim();
  if (force || hasQuery || fp !== _lastListFingerprint) {
    _lastListFingerprint = fp;
    await fetchContacts().catch(()=>{});
    updateTabBadges();
    renderList();
  }
}

async function fetchContacts(){
  const r=await fetch('/admin/api/contacts');
  const data=await r.json();
  const prev = _lastContactsFingerprint;
  allContacts=data.contacts||[];
  _lastContactsFingerprint = _contactsFingerprint();
  return _lastContactsFingerprint !== prev; // retorna true se mudou
}

function showContactModal(opts){
  const modal=$('contactModal');
  if(!modal) return;
  const isNew = !!opts?.isNew;
  $('cmTitle').textContent = isNew ? 'Novo contato' : 'Editar contato';
  $('cmWaId').value = (opts?.waId||'').toString();
  $('cmName').value = (opts?.name||'').toString();
  $('cmPhone').value = (opts?.phone||'').toString();
  $('cmDelete').style.display = isNew ? 'none' : 'inline-flex';
  modal.style.display='flex';
  const close=()=>{ modal.style.display='none'; };
  $('cmClose').onclick=close;
  modal.onclick=(e)=>{ if(e.target===modal) close(); };
  $('cmSave').onclick=async ()=>{
    const body={waId:$('cmWaId').value.trim(),name:$('cmName').value.trim(),phone:$('cmPhone').value.trim()};
    if(!body.waId) return;
    await fetch('/admin/api/contacts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    modal.style.display='none';
    await fetchContacts().catch(()=>{}); await fetchConversations().catch(()=>{});
  };
  $('cmDelete').onclick=async ()=>{
    const id=$('cmWaId').value.trim();
    if(!id) return;
    await fetch('/admin/api/contacts/'+encodeURIComponent(id),{method:'DELETE'});
    modal.style.display='none';
    await fetchContacts().catch(()=>{}); await fetchConversations().catch(()=>{}); renderList();
  };
}

function openNewContact(){
  showContactModal({isNew:true, waId:'', name:'', phone:''});
  const wa=$('cmWaId'); if(wa){ wa.disabled=false; wa.style.opacity='1'; wa.placeholder='Ex: 5511999999999'; }
}
function openEditContact(c){
  const wa=$('cmWaId'); if(wa){ wa.disabled=true; wa.style.opacity='.7'; wa.placeholder=''; }
  showContactModal({isNew:false, waId:c.waId, name:(c.name||''), phone:(c.phone||'')});
}

async function fetchConversation(waId){
  const r=await fetch('/admin/api/conversation/'+encodeURIComponent(waId));
  const data=await r.json();
  try{ if(data.conversation?.waId){ convCache.set(data.conversation.waId, data.conversation); } }catch(e){}
  return data.conversation;
}

function renderConversation(conv){
  activeData=conv;
  const isBlocked = conv.blocked || _panelBlockedSet.has(conv.waId);

  // header
  $('contactName').textContent=displayName(conv)||displayPhone(conv);
  $('contactSub').textContent='WaId: '+conv.waId+' • '+( conv.state||'idle' ) + (conv.topic?.label ? (' • '+conv.topic.label) : '');
  const av=$('chatHeaderAvatar');
  if(av){ av.textContent=avatarLetter(conv); av.className='chatHeader-avatar'+(isBlocked?' blocked-av':''); }
  $('actions').style.display='flex';
  $('composer').style.display= isBlocked ? 'none' : 'flex';

  // botões
  $('btnAssume').style.display = (conv.state==='manual' || conv.state==='ended' || isBlocked) ? 'none' : 'inline-flex';
  $('btnEnd').style.display = (conv.state==='manual' && !isBlocked) ? 'inline-flex' : 'none';
  $('btnEditContact').style.display='inline-flex';
  const btnBlock=$('btnBlock');
  if(btnBlock){
    if(isBlocked){ btnBlock.textContent='✅ Desbloquear'; btnBlock.className='primary'; }
    else { btnBlock.textContent='🚫 Bloquear'; btnBlock.className='danger'; }
  }

  // banner bloqueado
  const bb=$('blockedBanner');
  if(bb) bb.style.display = isBlocked ? 'block' : 'none';

  // mensagens — renderização incremental (só adiciona novas, sem apagar DOM existente)
  const msgsEl=$('messages');
  const msgs = conv.messages || [];
  const existingBubbles = msgsEl.querySelectorAll('.bubble').length;
  const isFullRedraw = existingBubbles === 0 || msgsEl.dataset.waId !== conv.waId;

  if (isFullRedraw) {
    msgsEl.innerHTML = '';
    msgsEl.dataset.waId = conv.waId;
  }

  // Só renderiza mensagens que ainda não estão no DOM
  const startIdx = isFullRedraw ? 0 : existingBubbles;
  // Recalcula o separador de data da última mensagem já renderizada
  let lastDateStr = isFullRedraw ? '' : (msgsEl.dataset.lastDate || '');

  for (let i = startIdx; i < msgs.length; i++) {
    const m = msgs[i];
    const dateStr = fmtDate(m.ts);
    if(dateStr && dateStr !== lastDateStr){
      lastDateStr = dateStr;
      msgsEl.dataset.lastDate = dateStr;
      const dd = document.createElement('div');
      dd.className = 'date-divider'; dd.textContent = dateStr;
      msgsEl.appendChild(dd);
    }
    const b = document.createElement('div');
    const cls = (m.from==='user')?'in':(m.from==='human'?'human':'out');
    b.className = 'bubble '+cls;
    const labelMap = {user:'Usuário',human:'Atendente',bot:'Bot',system:'Sistema'};
    const label = labelMap[m.from]||m.from;
    const safeText = (m.text||'').split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split(String.fromCharCode(10)).join('<br>').split(String.fromCharCode(13)).join('');

    // Renderização de mídia
    let mediaHTML = '';
    if (m.mediaId && m.mediaType) {
      const dlUrl = '/admin/api/media/' + encodeURIComponent(m.mediaId) + '?name=' + encodeURIComponent(m.mediaName || 'arquivo');
      if (m.mediaType === 'image') {
        mediaHTML = '<div class="media-wrap">'
          + '<img class="media-img" src="'+dlUrl+'" alt="imagem" loading="lazy" onclick="window.open(this.src)">'
          + '<a class="media-dl" href="'+dlUrl+'" download="'+(m.mediaName||'imagem.jpg')+'">⬇ Baixar imagem</a>'
          + '</div>';
      } else if (m.mediaType === 'video') {
        mediaHTML = '<div class="media-wrap">'
          + '<video class="media-video" controls preload="metadata"><source src="'+dlUrl+'"></video>'
          + '<a class="media-dl" href="'+dlUrl+'" download="'+(m.mediaName||'video.mp4')+'">⬇ Baixar vídeo</a>'
          + '</div>';
      } else if (m.mediaType === 'audio') {
        mediaHTML = '<div class="media-wrap">'
          + '<audio class="media-audio" controls><source src="'+dlUrl+'"></audio>'
          + '<a class="media-dl" href="'+dlUrl+'" download="'+(m.mediaName||'audio.ogg')+'">⬇ Baixar áudio</a>'
          + '</div>';
      } else if (m.mediaType === 'sticker') {
        mediaHTML = '<div class="media-wrap">'
          + '<img class="media-sticker" src="'+dlUrl+'" alt="sticker" loading="lazy">'
          + '</div>';
      } else {
        const icon = {'application/pdf':'📄','application/msword':'📝','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'📝','application/vnd.ms-excel':'📊','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'📊','application/zip':'🗜️'}[m.mediaMime] || '📎';
        mediaHTML = '<div class="media-wrap media-doc">'
          + '<span class="media-doc-icon">'+icon+'</span>'
          + '<span class="media-doc-name">'+(m.mediaName||'documento')+'</span>'
          + '<a class="media-dl" href="'+dlUrl+'" download="'+(m.mediaName||'documento')+'">⬇ Baixar</a>'
          + '</div>';
      }
    }

    const emptyMsg = (!mediaHTML && !safeText) ? '<span style="opacity:.45;font-style:italic;font-size:12px;">📎 Mídia não disponível</span>' : '';
    b.innerHTML = '<div class="bubble-label">'+label+'</div>'+mediaHTML+(safeText ? '<div class="bubble-text">'+safeText+'</div>' : '')+emptyMsg+'<span class="ts">'+fmtTS(m.ts)+'</span>';
    msgsEl.appendChild(b);
  }

  // Scroll só se estiver perto do final ou for carregamento inicial
  const el = msgsEl;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  if(nearBottom || msgs.length < 10) el.scrollTop = el.scrollHeight;
  markRead(conv.waId, true).catch(()=>{});
}

// Set local de bloqueados para renderização imediata (nome diferente do backend)
const _panelBlockedSet = new Set();
function syncBlocked(){
  _panelBlockedSet.clear();
  for(const c of allConvos){ if(c.blocked) _panelBlockedSet.add(c.waId); }
}

async function openConversation(waId){
  const mySeq = ++openSeq;
  activeId=waId;
  _lastConvFingerprint = ''; // reseta fingerprint ao trocar de conversa
  _lastActiveTs = '';
  const cached = convCache.get(waId);
  if(cached){
    if(mySeq!==openSeq) return;
    renderConversation(cached); renderList();
  } else {
    $('messages').innerHTML='<div class="empty">Carregando…</div>';
    $('contactName').textContent='Carregando…'; $('contactSub').textContent='';
    $('actions').style.display='none'; $('composer').style.display='none';
  }
  const conv=await fetchConversation(waId);
  if(mySeq!==openSeq) return;
  _lastConvFingerprint = _convFingerprint(conv);
  renderConversation(conv); renderList();
}

async function sendMessage(){
  const t=$('text').value.trim();
  const fileInput=$('fileInput');
  const hasFile = fileInput && fileInput.files && fileInput.files.length > 0;
  if(!activeId) return;
  if(hasFile){
    const file = fileInput.files[0];
    const fd = new FormData();
    fd.append('file', file);
    if(t) fd.append('caption', t);
    $('text').value=''; clearAttach();
    await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/media', {method:'POST', body:fd});
    return;
  }
  if(!t) return;
  $('text').value='';
  await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/message', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})});
}

function clearAttach(){
  const fi=$('fileInput'); if(fi) fi.value='';
  const ap=$('attachPreview'); if(ap) ap.style.display='none';
  $('attachName').textContent='';
}

// Botão de anexo
const _btnAttach=$('btnAttach');
if(_btnAttach){ _btnAttach.addEventListener('click',()=>{ const fi=$('fileInput'); if(fi) fi.click(); }); }
const _fileInput=$('fileInput');
if(_fileInput){ _fileInput.addEventListener('change',()=>{
  const f=_fileInput.files&&_fileInput.files[0];
  if(!f){ clearAttach(); return; }
  $('attachName').textContent=f.name; $('attachPreview').style.display='flex';
}); }

// Modal de iniciar conversa


async function assume(){ if(!activeId) return; await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/assume',{method:'POST'}); }
async function end(){ if(!activeId) return; await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/end',{method:'POST'}); }
async function markRead(waId,silent){ if(!waId) return; await fetch('/admin/api/conversation/'+encodeURIComponent(waId)+'/mark-read',{method:'POST'}); if(!silent) await fetchConversations(); }

async function toggleBlock(){
  if(!activeId) return;
  const isBlocked = _panelBlockedSet.has(activeId) || (activeData?.blocked);
  const route = isBlocked ? 'unblock' : 'block';
  await fetch('/admin/api/conversation/'+encodeURIComponent(activeId)+'/'+route, {method:'POST'});
  // Atualiza localmente o set de bloqueados
  if(isBlocked) _panelBlockedSet.delete(activeId); else _panelBlockedSet.add(activeId);
  // Força re-fetch ignorando fingerprint
  _lastListFingerprint = '';
  _lastActiveTs = '';
  await fetchConversations(true).catch(()=>{});
  syncBlocked();
  const conv = await fetchConversation(activeId);
  renderConversation(conv);
  renderList();
}

$('btnSend').onclick=sendMessage;
$('btnAssume').onclick=assume;
$('btnEnd').onclick=end;
$('btnBlock').onclick=toggleBlock;
$('btnEditContact').onclick=()=>{
  if(!activeId) return;
  const c=getContactById(activeId);
  if(c){ openEditContact(c); }
  else {
    const wa=$('cmWaId'); if(wa){ wa.disabled=true; wa.style.opacity='.9'; }
    showContactModal({isNew:false, waId:activeId, name:(activeData?.name||''), phone:''});
  }
};
$('btnNewContact').onclick=()=>{ openNewContact(); };
$('btnStartConv').onclick=()=>{ window.openStartModal && window.openStartModal(); };

// ── Modal de Iniciar Conversa ──────────────────────────────────────────────
(function(){
  function openStartModal(){
    if (!activeId) return;
    $('smWaId').value = activeId;
    $('smTemplate').value = 'avisos_rh';
    $('smLang').value = 'pt_BR';
    $('smError').textContent = '';
    // Mostra nome do contato no modal
    const name = (activeData && activeData.name) ? activeData.name : activeId;
    $('smContactName').textContent = '📨 Enviar template para: ' + name;
    $('startModal').style.display = 'flex';
  }
  function closeStartModal(){
    $('startModal').style.display = 'none';
  }

  $('smClose').onclick = closeStartModal;

  // Fecha ao clicar no backdrop
  $('startModal').addEventListener('click', function(e){
    if(e.target === this) closeStartModal();
  });

  $('smSend').onclick = async () => {
    const waId     = ($('smWaId').value     || '').trim();
    const template = ($('smTemplate').value || '').trim() || 'avisos_rh';
    const lang     = ($('smLang').value     || '').trim() || 'pt_BR';
    if (!waId) { $('smError').textContent = 'Informe o numero (WaId).'; return; }
    $('smError').textContent = '';
    $('smSend').disabled = true;
    try {
      const r = await fetch(
        '/admin/api/conversation/' + encodeURIComponent(waId) + '/start',
        { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ templateName: template, languageCode: lang }) }
      );
      const data = await r.json().catch(()=>({}));
      if (!r.ok) {
        const detail = (data && data.detail && data.detail.error && data.detail.error.message) || (data && data.detail) || (data && data.error) || ('HTTP ' + r.status);
        $('smError').textContent = 'Erro: ' + detail;
      } else {
        closeStartModal();
        await fetchConversations(true).catch(()=>{});
      }
    } catch(e) {
      $('smError').textContent = 'Erro de rede: ' + (e.message || e);
    } finally {
      $('smSend').disabled = false;
    }
  };

  window.openStartModal = openStartModal;
})();
// ──────────────────────────────────────────────────────────────────────────

const _textEl=$('text');
if(_textEl) _textEl.addEventListener('keydown',(e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); }});
const _qEl=$('q');
if(_qEl){
  _qEl.addEventListener('input', ()=>{
    _lastListFingerprint = ''; // força re-render no próximo poll também
    renderList();
  });
  // Limpar filtro com ESC
  _qEl.addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){ _qEl.value=''; _lastListFingerprint=''; renderList(); }
  });
}
const _tabs=$('tabs');
if(_tabs){
  window.__currentTab = window.__currentTab || 'queue';
  _tabs.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      _tabs.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      window.__currentTab = btn.dataset.tab;
      renderList();
    });
  });
}

// Polling a cada 3s — mais confiável que SSE em proxies como Koyeb
// Fingerprint da conversa ativa — evita re-render desnecessário (que causa piscar de imagens)
let _lastConvFingerprint = '';
let _lastListFingerprint = '';
let _lastContactsFingerprint = '';

function _convFingerprint(conv) {
  if (!conv) return '';
  const msgs = conv.messages || [];
  return msgs.length + '|' + (msgs[msgs.length-1]?.ts || '');
}
function _listFingerprint() {
  // Inclui blocked para detectar bloqueios/desbloqueios
  return allConvos.map(c => c.waId + '|' + (c.lastMessageAt || '') + '|' + (c.blocked ? '1' : '0')).join(',');
}
function _contactsFingerprint() {
  return allContacts.map(c => c.waId + c.name).join(',');
}

async function _poll() {
  try {
    await fetchConversations();
    syncBlocked();
    // Conversa aberta: só re-renderiza se chegou mensagem nova
    if (activeId) {
      const updated = allConvos.find(c => c.waId === activeId);
      const newTs = updated?.lastMessageAt || '';
      if (newTs && newTs !== _lastActiveTs) {
        _lastActiveTs = newTs;
        const conv = await fetchConversation(activeId);
        renderConversation(conv);
      }
    }
  } catch(e) {}
  setTimeout(_poll, 5000);
}
let _lastActiveTs = '';

// SSE como complemento — usa o mesmo fingerprint para evitar re-renders desnecessários
try {
  const es = new EventSource('/admin/events');
  es.onopen = () => {
    $('conn').textContent = '● Online';
    $('conn').style.color = '#00a884';
    fetchConversations().then(() => syncBlocked()).catch(() => {});
  };
  es.onerror = () => {};
  es.addEventListener('conversations', () => {
    fetchConversations().then(() => syncBlocked()).catch(() => {});
  });
  es.addEventListener('contacts', () => {
    fetchContacts().catch(() => {});
  });
  es.addEventListener('conversation', async (ev) => {
    try {
      const p = JSON.parse(ev.data || '{}');
      if (!p.waId) return;
      // Atualiza a lista
      await fetchConversations().catch(() => {});
      syncBlocked();
      // Se for a conversa aberta, verifica fingerprint antes de re-renderizar
      if (activeId && p.waId === activeId) {
        const updated = allConvos.find(c => c.waId === activeId);
        const newTs = updated?.lastMessageAt || '';
        if (newTs && newTs !== _lastActiveTs) {
          _lastActiveTs = newTs;
          const conv = await fetchConversation(activeId);
          renderConversation(conv);
        }
      }
    } catch(e) {}
  });
} catch(e) {}

// Carrega imediatamente ao abrir (marca Online antes mesmo do SSE)
$('conn').textContent = '● Online';
$('conn').style.color = '#00a884';
async function initialLoad(){
  await fetchConversations(true).catch(()=>{});
  syncBlocked();
  if(allConvos.length === 0){
    const delays = [1500, 2000, 2500, 3000, 4000];
    for(const delay of delays){
      await new Promise(r => setTimeout(r, delay));
      await fetchConversations(true).catch(()=>{});
      syncBlocked();
      if(allConvos.length > 0) break;
    }
  }
}
initialLoad();
setTimeout(_poll, 5000);

</script>
</body></html>`;
}

//exibe a pagina quando alguem abre

// Admin: anti-cache para evitar painel antigo após deploy/restart
// Admin: anti-cache para evitar painel antigo após deploy/restart (exceto SSE)
app.use("/admin", (req, res, next) => {
  if (req.path === "/events") return next(); // SSE não pode ter no-store
  setNoCache(res);
  next();
});
app.get("/admin", (req, res) => res.status(200).send(adminHTML()));

//mantem o bot ao vivo
app.get("/admin/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // desativa buffer do nginx/proxy
  res.flushHeaders?.();

  const id = String(sseSeq++);
  sseClients.set(id, res);
  try { sseSend(res, "hello", { ok: true, at: nowISO() }); } catch (e) {}

  // heartbeat a cada 25s para manter conexão viva em proxies/Koyeb
  const hb = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (e) { clearInterval(hb); }
  }, 25000);

  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(id);
  });
});

// -----------------------------
// Estado efetivo para o PAINEL (/admin)
// -----------------------------
// Observação: o Map `state` não é persistido. Após restart/deploy, ele volta vazio,
// então o painel enxergaria "idle" e classificaria como "Em atendimento ROBÔ".
// Para evitar isso, inferimos "ended" quando a ÚLTIMA mensagem registrada for o THANKS,
// e só volta a ser "robô" quando o usuário mandar nova mensagem (ou o estado real existir).
function getEffectiveStateForPanel(waId, inferredQueuePositions) {
  const real = state.get(waId);

  // Se existe estado real (em memória), ele sempre prevalece.
  if (real === "ended") return "ended";
  if (real === "manual") return "manual";
  if (real === "handover") return "handover";
  if (real && real !== "idle") return real;

  // Se está na fila (memória), o painel deve tratar como handover
  if (inQueue.has(waId)) return "handover";

  // ── CORREÇÃO: analisa histórico de forma mais rigorosa ─────────────────────
  const convo = peekConvo(waId);
  const msgs = (convo && convo.messages) ? convo.messages : [];

  if (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    const lastText = (last?.text || "").toString().trim();
    const thanksText = (THANKS || "").toString().trim();

    // Últimas mensagens do bot com mensagem de encerramento → encerrado
    if ((last?.from === "bot" || last?.from === "human") && lastText === thanksText) {
      return "ended";
    }

    // Última mensagem foi do humano (atendente) → manual (já assumido)
    if (last?.from === "human") {
      // Mas se foi uma mensagem de sistema/template de início, não conta como manual
      if (!lastText.startsWith("[Template enviado:")) {
        return "manual";
      }
    }

    // Verifica se o usuário voltou ao fluxo do bot após eventual handover
    // Procura marcadores de retomada nas últimas mensagens (mais recentes primeiro)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m) continue;
      const txt = (m.text || "").toString().trim();
      // Se encontrou encerramento → encerrado
      if ((m.from === "bot" || m.from === "human") && txt === thanksText) return "ended";
      // Se encontrou retomada do robô → robô ativo
      if (m.from === "bot" && _isBotResumeMarkerText(txt)) {
        // Ainda precisa checar se depois disso houve handover novamente
        // Como estamos varrendo do mais recente, se chegou aqui, retomada é a mais recente
        return real || "idle";
      }
      // Se encontrou handover → na fila (caso não tenha sido resolvido acima)
      if (m.from === "bot" && _isHandoverMarkerText(txt)) break;
    }
  }

  // Fallback: usa inferência de fila completa
  const inferred = inferQueueFromHistoryForPanel(waId);
  if (inferred.inQueue) return "handover";

  return real || "idle";
}

// -----------------------------
// BLINDAGEM DE STATUS (pós-restart/deploy)
// - NÃO altera fluxo do bot
// - Apenas garante que "Na fila" continue "Na fila" mesmo após atualização do servidor
// -----------------------------
function _toMs(iso) {
  try {
    const t = new Date(iso).getTime();
    return isNaN(t) ? 0 : t;
  } catch (e) {
    return 0;
  }
}

function _includesAny(txt, arr) {
  const s = (txt || "").toString();
  return arr.some(k => s.includes(k));
}

// Detecta o "marcador" de encaminhamento para humano (texto do handoverMsg)
function _isHandoverMarkerText(txt) {
  const s = (txt || "").toString();
  return s.includes("Encaminhando para um atendente humano");
}

// Detecta mensagens do bot que indicam que o usuário VOLTOU ao fluxo do robô (menu/etapas)
function _isBotResumeMarkerText(txt) {
  const s = (txt || "").toString();
  // marcadores bem específicos do seu fluxo (evita falsos positivos)
  return _includesAny(s, [
    "O que você deseja fazer hoje?",
    "Por favor, escolha uma opção:",
    "Deseja voltar ao Menu Inicial?",
    "Olá 👋, eu sou o assistente virtual do RH.",
    "Antes de começarmos, me diga seu *nome completo*",
  ]);
}

// Retorna { inQueue: boolean, queueAtISO: string|null }
function inferQueueFromHistoryForPanel(waId) {
  const convo = peekConvo(waId);
  const msgs = (convo && convo.messages) ? convo.messages : [];
  if (!msgs.length) return { inQueue: false, queueAtISO: null };

  // Se já encerrou, não pode estar na fila
  const thanksText = (THANKS || "").toString().trim();
  const last = msgs[msgs.length - 1];
  const lastText = (last?.text || "").toString().trim();
  if ((last?.from === "bot" || last?.from === "human") && lastText === thanksText) {
    return { inQueue: false, queueAtISO: null };
  }

  // Se último foi humano, também não está na fila (já assumiram)
  if (last?.from === "human") {
    return { inQueue: false, queueAtISO: null };
  }

  // Busca o último "encaminhando para humano" no histórico
  let lastHandoverIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.from === "bot" && _isHandoverMarkerText(m?.text)) {
      lastHandoverIdx = i;
      break;
    }
  }
  if (lastHandoverIdx < 0) return { inQueue: false, queueAtISO: null };

  const handoverAt = msgs[lastHandoverIdx]?.ts || null;
  const handoverAtMs = _toMs(handoverAt);

  // Se depois do handover houver qualquer "marcador de retomada do robô", então a pessoa saiu da fila
  for (let i = lastHandoverIdx + 1; i < msgs.length; i++) {
    const m = msgs[i];
    const ms = _toMs(m?.ts);
    if (ms && handoverAtMs && ms < handoverAtMs) continue;

    if (m?.from === "human") return { inQueue: false, queueAtISO: null };
    if ((m?.from === "bot" || m?.from === "human") && ((m?.text || "").toString().trim() === thanksText)) {
      return { inQueue: false, queueAtISO: null };
    }
    if (m?.from === "bot" && _isBotResumeMarkerText(m?.text)) {
      return { inQueue: false, queueAtISO: null };
    }
  }

  // Se chegou aqui: último handover ainda "vale" e não houve retomada/assunção/encerramento depois
  return { inQueue: true, queueAtISO: handoverAt };
}

// Monta posições inferidas da fila com base no momento do handover (mantém ordem após restart)
function computeInferredQueuePositionsForPanel() {
  const arr = [];
  for (const [waId, _convo] of convoStore.entries()) {
    // Se já está na fila em memória, não precisa inferir
    if (inQueue.has(waId) || state.get(waId) === "handover") continue;

    const inf = inferQueueFromHistoryForPanel(waId);
    if (inf.inQueue && inf.queueAtISO) {
      arr.push({ waId, atMs: _toMs(inf.queueAtISO) || 0 });
    }
  }
  arr.sort((a, b) => (a.atMs - b.atMs) || String(a.waId).localeCompare(String(b.waId)));

  const posMap = new Map();
  for (let i = 0; i < arr.length; i++) {
    posMap.set(arr[i].waId, i + 1);
  }
  return posMap;
}

// Retorna { inQueue:boolean, queuePos:number } para o painel, combinando memória + inferência
function getEffectiveQueueInfoForPanel(waId, inferredPosMap) {
  // Memória (tempo real) sempre vence
  if (inQueue.has(waId) || state.get(waId) === "handover") {
    const pos = inQueue.has(waId) ? (handoverQueue.findIndex((x)=>x.from===waId)+1) : 0;
    return { inQueue: true, queuePos: pos || 0 };
  }

  // Inferência pós-restart
  const inf = inferQueueFromHistoryForPanel(waId);
  if (inf.inQueue) {
    const pos = (inferredPosMap && inferredPosMap.get(waId)) ? inferredPosMap.get(waId) : 0;
    return { inQueue: true, queuePos: pos || 0 };
  }

  return { inQueue: false, queuePos: 0 };
}

//Essa rota devolve a lista de conversas pro painel:
app.get("/admin/api/conversations", (req, res) => {
  const inferredPosMap = computeInferredQueuePositionsForPanel();
  const conversations = [];
  for (const [waId, convo] of convoStore.entries()) {
    const qi = getEffectiveQueueInfoForPanel(waId, inferredPosMap);
    const name = getContactName(waId) || "";
    conversations.push({
      waId,
      name,
      displayPhone: getContactPhone(waId),
      state: getEffectiveStateForPanel(waId, inferredPosMap),
      topic: handoverTopics.get(waId) || null,
      inQueue: qi.inQueue,
      queuePos: qi.queuePos,
      unread: convo.unread || 0,
      lastMessageAt: convo.lastMessageAt,
      lastUserMessageAt: convo.lastUserMessageAt,
      blocked: blockedSet.has(waId),
    });
  }
  res.json({ conversations });
});


// -----------------------------
// CONTATOS (painel)
// -----------------------------
app.get("/admin/api/contacts", (req, res) => {
  const inferredPosMap = computeInferredQueuePositionsForPanel();
  const contacts = Array.from(contactsStore.values()).map(c => ({
    waId: c.waId,
    name: (c.name || "").toString(),
    phone: (c.phone || "").toString(),
    displayPhone: (c.phone || "").toString().trim() ? c.phone : toDisplayPhone(c.waId),
    updatedAt: c.updatedAt || null,
    hasConversation: convoStore.has(c.waId),
    state: getEffectiveStateForPanel(c.waId, inferredPosMap),
    inQueue: getEffectiveQueueInfoForPanel(c.waId, inferredPosMap).inQueue,
    queuePos: getEffectiveQueueInfoForPanel(c.waId, inferredPosMap).queuePos,
    lastMessageAt: peekConvo(c.waId).lastMessageAt,
    lastUserMessageAt: peekConvo(c.waId).lastUserMessageAt,
  }));
  res.json({ contacts });
});

app.post("/admin/api/contacts", (req, res) => {
  const waId = (req.body?.waId || "").toString().trim();
  const name = (req.body?.name || "").toString().trim();
  const phone = (req.body?.phone || "").toString().trim();
  if (!waId) return res.status(400).json({ error: "missing_waId" });

  const saved = upsertContact(waId, { name, phone });
  broadcast("conversations", { at: nowISO() });
  if (convoStore.has(waId)) {
    broadcast("conversation", { waId, at: nowISO() });
  }
  return res.json({ ok: true, contact: saved });
});

app.delete("/admin/api/contacts/:waId", (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  const ok = deleteContact(waId);
  return res.json({ ok });
});

//Essa rota devolve uma conversa específica (pra abrir no chat).
app.get("/admin/api/conversation/:waId", (req, res) => {
  const inferredPosMap = computeInferredQueuePositionsForPanel();
  const waId = (req.params.waId || "").toString().trim();
  const convo = peekConvo(waId);
  const name = getContactName(waId) || "";
  res.json({
    conversation: {
      waId,
      name,
      displayPhone: getContactPhone(waId),
      state: getEffectiveStateForPanel(waId, inferredPosMap),
      inQueue: getEffectiveQueueInfoForPanel(waId, inferredPosMap).inQueue,
      queuePos: getEffectiveQueueInfoForPanel(waId, inferredPosMap).queuePos,
      topic: handoverTopics.get(waId) || null,
      unread: convo.unread || 0,
      lastMessageAt: convo.lastMessageAt,
      lastUserMessageAt: convo.lastUserMessageAt,
      messages: (convo.messages || []).slice(-500),
    }
  });
});

app.post("/admin/api/conversation/:waId/mark-read", (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  markRead(waId);
  res.json({ ok: true });
});

app.post("/admin/api/conversation/:waId/assume", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  removeFromQueue(waId);
  setState(waId, "manual");
  stopInactivity(waId);
  markRead(waId);
  const nm = userNames.get(waId);
  await sendHumanText(waId, `Atendimento Humano iniciado${nm ? `, ${nm}` : ""}. Pode me explicar sua dúvida?`);
  res.json({ ok: true });
});

app.post("/admin/api/conversation/:waId/end", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  removeFromQueue(waId);
  setState(waId, "ended");
  markRead(waId);
  await sendHumanText(waId, THANKS);
  res.json({ ok: true });
});

// --- Bloquear / Desbloquear contato ---
app.post("/admin/api/conversation/:waId/block", (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  if (!waId) return res.status(400).json({ error: "missing_waId" });
  // Encerra a conversa ativa se houver
  removeFromQueue(waId);
  setState(waId, "ended");
  stopInactivity(waId);
  blockContact(waId);
  res.json({ ok: true, blocked: true });
});

app.post("/admin/api/conversation/:waId/unblock", (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  if (!waId) return res.status(400).json({ error: "missing_waId" });
  unblockContact(waId);
  res.json({ ok: true, blocked: false });
});

app.post("/admin/api/conversation/:waId/message", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ error: "empty_text" });

  if ((state.get(waId) || "") !== "manual") {
    removeFromQueue(waId);
    setState(waId, "manual");
    stopInactivity(waId);
  }

  //Zera não lidas do usuário.
  markRead(waId);
  await sendHumanText(waId, text);
  res.json({ ok: true });
});

// --- Envio de anexo (mídia) pelo painel ---
app.post("/admin/api/conversation/:waId/media", upload.single("file"), async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  if (!req.file) return res.status(400).json({ error: "no_file" });

  const caption = (req.body?.caption || "").toString().trim();
  const mimeType = req.file.mimetype || "application/octet-stream";
  const originalName = req.file.originalname || "arquivo";

  // Determina o tipo de mídia pelo MIME
  let mediaType = "document";
  if (mimeType.startsWith("image/")) mediaType = "image";
  else if (mimeType.startsWith("video/")) mediaType = "video";
  else if (mimeType.startsWith("audio/")) mediaType = "audio";

  try {
    const mediaId = await uploadMediaToMeta(req.file.path, mimeType);

    if ((state.get(waId) || "") !== "manual") {
      removeFromQueue(waId);
      setState(waId, "manual");
      stopInactivity(waId);
    }
    markRead(waId);
    await sendHumanMedia(waId, { type: mediaType, mediaId, caption, filename: originalName });
    res.json({ ok: true });
  } catch (e) {
    console.error("Erro ao enviar mídia:", e?.response?.data || e.message);
    res.status(500).json({ error: "media_send_failed", detail: e?.response?.data || e.message });
  } finally {
    // Remove o arquivo temporário
    try { fs.unlinkSync(req.file.path); } catch (_) {}
  }
});

// --- Iniciar conversa (template) pelo painel ---
// Envia o template hello_world para um número que ainda não interagiu (ou passou 24h).
// A Meta cobra por mensagem de template fora da janela de 24h.
app.post("/admin/api/conversation/:waId/start", async (req, res) => {
  const waId = (req.params.waId || "").toString().trim();
  if (!waId) return res.status(400).json({ error: "missing_waId" });

  // Template opcional: permite usar outro template configurado nas variáveis de ambiente
  const templateName = (req.body?.templateName || process.env.START_TEMPLATE_NAME || "avisos_rh").toString().trim();
  const languageCode = (req.body?.languageCode || process.env.START_TEMPLATE_LANG || "pt_BR").toString().trim();

  const url = `https://graph.facebook.com/v22.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: waId,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    await axios.post(url, body, { headers });
    try { logMessage(waId, "human", `[Template enviado: ${templateName}]`); } catch (_) {}
    // Garante que o contato aparece no painel
    getConvo(waId);
    broadcast("conversations", { at: nowISO() });
    res.json({ ok: true, template: templateName });
  } catch (e) {
    console.error("Erro ao iniciar conversa (template):", e?.response?.data || e.message);
    res.status(500).json({ error: "template_send_failed", detail: e?.response?.data || e.message });
  }
});

// =========================================================================================== FIM PAINEL ADMIN ==========================================================================

// ── Proxy de mídia: busca URL temporária da Meta e redireciona o download ───────────────
app.get("/admin/api/media/:mediaId", async (req, res) => {
  const { mediaId } = req.params;
  const filename = req.query.name || "arquivo";
  try {
    // 1) Busca os metadados da mídia (inclui URL temporária)
    const metaRes = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );
    const mediaUrl = metaRes.data?.url;
    if (!mediaUrl) return res.status(404).json({ error: "url_not_found" });

    // 2) Faz o download do arquivo da Meta e repassa ao browser
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      responseType: "stream",
    });

    const mime = fileRes.headers["content-type"] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    // Imagens e vídeos exibem inline (para renderizar no painel); demais forçam download
    const isInline = mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/");
    const disposition = isInline
      ? `inline; filename="${encodeURIComponent(filename)}"`
      : `attachment; filename="${encodeURIComponent(filename)}"`;
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (fileRes.headers["content-length"]) {
      res.setHeader("Content-Length", fileRes.headers["content-length"]);
    }
    fileRes.data.pipe(res);
  } catch (e) {
    console.error("Erro ao buscar mídia:", e?.response?.data || e.message);
    res.status(500).json({ error: "media_fetch_failed" });
  }
});

app.listen(PORT, () => { //inicialização do boot no servidor

  //Confirma visualmente no terminal que o servidor iniciou corretamente.
  console.log(`Servidor rodando na porta ${PORT}`);
  // Mostra apenas o tamanho do token, e não o valor real — boa prática de segurança.Serve para garantir que a variável de ambiente foi lida (e não está vazia)
  console.log("DEBUG TOKEN len:", (process.env.WHATSAPP_TOKEN || "").length);
  //Mostra o ID do número de WhatsApp que está configurado — útil para checar se está certo antes de testar a API.
  console.log("DEBUG PHONE_NUMBER_ID:", process.env.PHONE_NUMBER_ID);

  // Verificação básica das variáveis de ambiente
  if (!process.env.WHATSAPP_TOKEN) {
    console.warn("⚠️  Atenção: variável WHATSAPP_TOKEN não encontrada no .env!");
  }
  if (!process.env.PHONE_NUMBER_ID) {
    console.warn("⚠️  Atenção: variável PHONE_NUMBER_ID não encontrada no .env!");
  }
  if (!process.env.SMTP_USER) {
    console.warn("⚠️  Atenção: variável SMTP_USER não encontrada no .env!");
  }
});

// ===============================================================================Tratamentos globais de erro =====================================================================
process.on("unhandledRejection", (err) => {
  console.error("🚨 Unhandled Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("🚨 Uncaught Exception:", err);
});
