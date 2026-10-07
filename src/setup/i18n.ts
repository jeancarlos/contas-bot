import type { Lang } from '../i18n.ts'

export type SetupText = {
  title: (v: string) => string
  currency: string; currencyInvalid: string
  pairing: string; pairingQr: string; pairingCode: string
  phone: string; phoneInvalid: string
  ai: string; aiGemini: string; aiGeminiHint: string; aiOpenai: string; aiCustom: string; aiCustomHint: string; aiNone: string; aiNoneHint: string
  aiKey: (where: string) => string; aiUrl: string; aiUrlInvalid: string; aiModel: string; required: string
  aiChecking: string; aiOk: string; aiFailed: string; aiRetry: string
  group: string; groupInvalid: string
  summary: string; confirm: string; saved: string
  existingTitle: string; existingAsk: string; keep: string; review: string; keyKept: string
  qrSteps: string; codeSteps: string; waiting: string; paired: string; pairFailed: string; pairRetry: string
  updated: (from: string, to: string) => string
  cancelled: string
  missing: (keys: string) => string
}

const pt: SetupText = {
  title: v => `🤖💸 contas-bot · v${v}`,
  currency: 'Moeda (código ISO)', currencyInvalid: 'use 3 letras, como BRL, USD, EUR',
  pairing: 'Como conectar o WhatsApp do bot?', pairingQr: 'QR na tela (recomendado)', pairingCode: 'Código de 8 letras',
  phone: 'Número do WhatsApp do bot, com DDI e DDD', phoneInvalid: 'número com 10 a 15 dígitos, ex: +55 49 92005-5837',
  ai: 'Qual IA lê os comprovantes?', aiGemini: 'Google Gemini', aiGeminiHint: 'grátis', aiOpenai: 'OpenAI',
  aiCustom: 'Meu próprio endpoint', aiCustomHint: '9router, Ollama, LiteLLM…', aiNone: 'Sem IA', aiNoneHint: 'só comprovantes com legenda',
  aiKey: where => (where ? `Chave da API (pegue em ${where})` : 'Chave da API (Enter se não tiver)'),
  aiUrl: 'URL base compatível com OpenAI', aiUrlInvalid: 'comece com http:// ou https://', aiModel: 'Modelo que lê imagens', required: 'obrigatório',
  aiChecking: 'Testando a IA…', aiOk: '✅ A IA respondeu', aiFailed: '⚠️ A IA não respondeu com essa chave/URL', aiRetry: 'Corrigir agora?',
  group: 'Link de convite do grupo (opcional, Enter pula)', groupInvalid: 'cole um link chat.whatsapp.com ou deixe vazio',
  summary: 'Confira', confirm: 'Gravar e continuar?', saved: '✅ Configuração gravada',
  existingTitle: '📋 Configuração atual', existingAsk: 'O que fazer com ela?', keep: 'Manter', review: 'Revisar', keyKept: 'Enter mantém a chave atual',
  qrSteps: '📱 No celular do bot: WhatsApp → Aparelhos conectados → Conectar um aparelho → aponte a câmera para o QR',
  codeSteps: '📱 No celular do bot: WhatsApp → Aparelhos conectados → Conectar um aparelho → NÃO escaneie o QR: toque em "Conectar com número de telefone" e digite o código',
  waiting: 'esperando o celular…', paired: '✅ Conectado! O bot vai subir agora.',
  pairFailed: '⏸️ O QR/código expirou ou foi recusado', pairRetry: 'Gerar um novo?',
  updated: (from, to) => `✅ Atualizado: v${from} → v${to}`,
  cancelled: 'Cancelado, nada foi gravado.',
  missing: keys => `faltam respostas e não há terminal para perguntar: ${keys}`,
}

const en: SetupText = {
  title: v => `🤖💸 contas-bot · v${v}`,
  currency: 'Currency (ISO code)', currencyInvalid: 'use 3 letters, like USD, EUR, BRL',
  pairing: "How should the bot's WhatsApp connect?", pairingQr: 'QR on screen (recommended)', pairingCode: '8-letter code',
  phone: "The bot's WhatsApp number, with country code", phoneInvalid: 'a number with 10 to 15 digits, e.g. +1 415 555 0100',
  ai: 'Which AI reads the receipts?', aiGemini: 'Google Gemini', aiGeminiHint: 'free', aiOpenai: 'OpenAI',
  aiCustom: 'My own endpoint', aiCustomHint: '9router, Ollama, LiteLLM…', aiNone: 'No AI', aiNoneHint: 'captioned receipts only',
  aiKey: where => (where ? `API key (get one at ${where})` : 'API key (Enter if none)'),
  aiUrl: 'OpenAI-compatible base URL', aiUrlInvalid: 'start with http:// or https://', aiModel: 'Model that reads images', required: 'required',
  aiChecking: 'Testing the AI…', aiOk: '✅ The AI answered', aiFailed: "⚠️ The AI didn't answer with that key/URL", aiRetry: 'Fix it now?',
  group: 'Group invite link (optional, Enter skips)', groupInvalid: 'paste a chat.whatsapp.com link or leave it empty',
  summary: 'Review', confirm: 'Save and continue?', saved: '✅ Settings saved',
  existingTitle: '📋 Current settings', existingAsk: 'What to do with them?', keep: 'Keep', review: 'Review', keyKept: 'Enter keeps the current key',
  qrSteps: "📱 On the bot's phone: WhatsApp → Linked devices → Link a device → point the camera at the QR",
  codeSteps: `📱 On the bot's phone: WhatsApp → Linked devices → Link a device → DON'T scan: tap "Link with phone number instead" and type the code`,
  waiting: 'waiting for the phone…', paired: '✅ Connected! Starting the bot now.',
  pairFailed: '⏸️ The QR/code expired or was refused', pairRetry: 'Make a new one?',
  updated: (from, to) => `✅ Updated: v${from} → v${to}`,
  cancelled: 'Cancelled, nothing was saved.',
  missing: keys => `answers are missing and there is no terminal to ask: ${keys}`,
}

const es: SetupText = {
  title: v => `🤖💸 contas-bot · v${v}`,
  currency: 'Moneda (código ISO)', currencyInvalid: 'usa 3 letras, como EUR, USD, MXN',
  pairing: '¿Cómo conectar el WhatsApp del bot?', pairingQr: 'QR en pantalla (recomendado)', pairingCode: 'Código de 8 letras',
  phone: 'Número de WhatsApp del bot, con código de país', phoneInvalid: 'un número de 10 a 15 dígitos, ej: +34 600 000 000',
  ai: '¿Qué IA lee los comprobantes?', aiGemini: 'Google Gemini', aiGeminiHint: 'gratis', aiOpenai: 'OpenAI',
  aiCustom: 'Mi propio endpoint', aiCustomHint: '9router, Ollama, LiteLLM…', aiNone: 'Sin IA', aiNoneHint: 'solo comprobantes con leyenda',
  aiKey: where => (where ? `Clave de la API (consíguela en ${where})` : 'Clave de la API (Enter si no tienes)'),
  aiUrl: 'URL base compatible con OpenAI', aiUrlInvalid: 'empieza con http:// o https://', aiModel: 'Modelo que lee imágenes', required: 'obligatorio',
  aiChecking: 'Probando la IA…', aiOk: '✅ La IA respondió', aiFailed: '⚠️ La IA no respondió con esa clave/URL', aiRetry: '¿Corregir ahora?',
  group: 'Enlace de invitación del grupo (opcional, Enter salta)', groupInvalid: 'pega un enlace chat.whatsapp.com o déjalo vacío',
  summary: 'Revisa', confirm: '¿Guardar y continuar?', saved: '✅ Configuración guardada',
  existingTitle: '📋 Configuración actual', existingAsk: '¿Qué hacemos con ella?', keep: 'Mantener', review: 'Revisar', keyKept: 'Enter conserva la clave actual',
  qrSteps: '📱 En el teléfono del bot: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → apunta la cámara al QR',
  codeSteps: '📱 En el teléfono del bot: WhatsApp → Dispositivos vinculados → Vincular un dispositivo → NO escanees: toca "Vincular con el número de teléfono" y escribe el código',
  waiting: 'esperando el teléfono…', paired: '✅ ¡Conectado! El bot arranca ahora.',
  pairFailed: '⏸️ El QR/código expiró o fue rechazado', pairRetry: '¿Generar uno nuevo?',
  updated: (from, to) => `✅ Actualizado: v${from} → v${to}`,
  cancelled: 'Cancelado, no se guardó nada.',
  missing: keys => `faltan respuestas y no hay terminal para preguntar: ${keys}`,
}

export const SETUP_TEXT: Record<Lang, SetupText> = { 'pt-BR': pt, en, es }
