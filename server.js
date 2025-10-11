import { createServer } from "http"
import { Server } from "socket.io"
import { generateShortId } from "./utils/generador.js"
import dotenv from "dotenv"
import { readFile } from "fs/promises"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PORT = process.env.SOCKET_PORT || 4000

const serverStartTime = Date.now()

const AGENT_ORIGINS = process.env.AGENT_ORIGINS
  ? process.env.AGENT_ORIGINS.split(",").map((origin) => origin.trim())
  : ["https://fantickets.cloud/design/agent-panel"]

console.log(`🔐 Configured agent origins:`, AGENT_ORIGINS)

// Crear servidor HTTP
const httpServer = createServer()

// Configurar Socket.IO con CORS
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true)

      const allowedOrigins = ["http://localhost:3000", "http://localhost:5174"]

      const isSubdomain = /^https:\/\/.*\.your-domain\.com$/.test(origin)

      if (
        allowedOrigins.includes(origin) ||
        isSubdomain ||
        AGENT_ORIGINS.some((agentOrigin) => origin.startsWith(agentOrigin))
      ) {
        callback(null, true)
      } else {
        console.log(`🚫 CORS blocked origin: ${origin}`)
        callback(new Error("Not allowed by CORS"))
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
})

// Almacenar chats activos y agentes conectados
const activeChats = new Map()
const connectedAgents = new Map()

const socketOrigins = new Map()

const AUTOSAVE_INTERVAL = 5 * 60 * 1000 // 5 minutos
const INACTIVITY_SAVE_DELAY = 2 * 60 * 1000 // 2 minutos de inactividad

// Rastrear última actividad de cada chat
const chatLastActivity = new Map()
const chatSaveTimers = new Map()

// Función para guardar chat en base de datos
async function saveChatToDatabase(chat) {
  console.log(`💾 Saving chat to API: ${chat.chatroom_id}`)

  // Calculate last message time
  const lastMessage = chat.messages[chat.messages.length - 1]
  const lastMessageAt = lastMessage ? lastMessage.time : chat.createdAt

  const chatData = {
    chatroom_id: chat.chatroom_id,
    agent_id: chat.agent || null,
    user_id: chat.userId,
    user_name: chat.userName,
    user_email: chat.userEmail,
    user_phone: chat.userPhone,
    user_ip: chat.userIp,
    socket_id: chat.socketId,
    status: chat.agent ? "closed" : "pending",
    last_message_at: lastMessageAt,
    messages: chat.messages,
  }

  try {
    const apiUrl = process.env.CHAT_API_URL

    if (!apiUrl) {
      console.warn(`⚠️ CHAT_API_URL not configured, using file fallback`)
      throw new Error("API URL not configured")
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.CHAT_API_KEY && {
          Authorization: `Bearer ${process.env.CHAT_API_KEY}`,
        }),
      },
      body: JSON.stringify(chatData),
    })

    if (!response.ok) {
      throw new Error(`API responded with status ${response.status}`)
    }

    const result = await response.json()
    console.log(`✅ Chat saved to API successfully: ${chat.chatroom_id}`)
    return { success: true, chatId: chat.chatroom_id, result }
  } catch (error) {
    console.error(`❌ Error saving chat to API ${chat.chatroom_id}:`, error)

    try {
      const fs = await import("fs/promises")
      const path = await import("path")

      const chatsDir = path.join(process.cwd(), "saved_chats")
      await fs.mkdir(chatsDir, { recursive: true })

      const filename = `${chat.chatroom_id}_${Date.now()}.json`
      await fs.writeFile(path.join(chatsDir, filename), JSON.stringify(chatData, null, 2))

      console.log(`✅ Chat saved to file as fallback: ${chat.chatroom_id}`)
      return { success: true, chatId: chat.chatroom_id, fallback: true }
    } catch (fileError) {
      console.error(`❌ Fallback file save also failed:`, fileError)
      return { success: false, error: fileError }
    }
  }
}

function scheduleAutoSave(chatId) {
  const chat = activeChats.get(chatId)

  // Solo auto-guardar si hay un agente asignado
  if (!chat || !chat.agent) {
    return
  }

  // Cancelar timer anterior si existe
  if (chatSaveTimers.has(chatId)) {
    clearTimeout(chatSaveTimers.get(chatId))
  }

  // Programar nuevo guardado después de inactividad
  const timer = setTimeout(async () => {
    const currentChat = activeChats.get(chatId)
    if (currentChat && currentChat.messages.length > 0 && currentChat.agent) {
      console.log(`⏰ Auto-saving chat after inactivity: ${currentChat.chatroom_id}`)
      await saveChatToDatabase(currentChat)
    }
    chatSaveTimers.delete(chatId)
  }, INACTIVITY_SAVE_DELAY)

  chatSaveTimers.set(chatId, timer)
}

// Actualizar última actividad del chat
function updateChatActivity(chatId) {
  chatLastActivity.set(chatId, Date.now())
  scheduleAutoSave(chatId)
}

console.log(`🚀 Socket.IO server starting on port ${PORT}`)

io.on("connection", (socket) => {
  const origin = socket.handshake.headers.origin || socket.handshake.headers.referer

  socketOrigins.set(socket.id, origin)

  const isAgentOrigin = AGENT_ORIGINS.some((agentOrigin) => origin && origin.startsWith(agentOrigin))

  if (isAgentOrigin) {
    console.log(`🔐 Connection from agent origin detected: ${origin}`)
    socket.emit("identified_as_agent", {
      origin,
      message: "You are connecting from an authorized agent domain",
    })
  }

  console.log(`📱 New connection: ${socket.id} from ${origin || "unknown"}`)

  socket.on("user_join_chat", (data) => {
    if (isAgentOrigin) {
      console.log(`⚠️ Agent origin attempted to join as user, blocking: ${socket.id}`)
      socket.emit("error", {
        message: "Agent origins cannot create user chats. Please use join_as_agent instead.",
      })
      return
    }

    const { userId, userName, userEmail, userPhone } = data
    const chatId = generateShortId("chat")

    console.log(`👤 User joined chat: ${userName} (${userId})`)

    // Crear nuevo chat
    const newChat = {
      chatroom_id: chatId,
      userId,
      userName,
      userEmail: userEmail || "",
      userPhone: userPhone || "",
      userIp: socket.handshake.address || "unknown",
      messages: [],
      createdAt: new Date().toISOString(),
      socketId: socket.id,
    }

    activeChats.set(chatId, newChat)
    socket.join(chatId)

    // Confirmar al usuario que el chat fue creado
    socket.emit("chat_created", { chatId })

    // Notificar a todos los agentes sobre el nuevo chat
    socket.broadcast.emit("new_chat", newChat)

    console.log(`✅ Chat created: ${chatId}`)
  })

  socket.on("user_message", (data) => {
    const { chatId, content, sender } = data

    console.log(`💬 User message in chat ${chatId}: ${content}`)

    const chat = activeChats.get(chatId)
    if (!chat) {
      console.log(`❌ Chat not found: ${chatId}`)
      return
    }

    const message = {
      id: generateShortId("msg"),
      content,
      sender: sender || "user",
      senderName: chat.userName,
      time: new Date().toISOString(),
    }

    // Guardar mensaje en el chat
    chat.messages.push(message)

    // Enviar mensaje a todos en la sala (incluyendo agentes)
    io.to(chatId).emit("new_message", {
      chatId,
      message,
    })

    console.log(`✅ Message sent to chat ${chatId}`)

    if (chat.agent) {
      updateChatActivity(chatId)
    }
  })

  socket.on("user_typing", (data) => {
    const { chatId } = data
    console.log(`⌨️ User typing in chat: ${chatId}`)

    // Notificar a los agentes
    socket.to(chatId).emit("user_typing", { chatId })
  })

  socket.on("user_stop_typing", (data) => {
    const { chatId } = data
    console.log(`✋ User stopped typing in chat: ${chatId}`)

    // Notificar a los agentes
    socket.to(chatId).emit("user_stop_typing", { chatId })
  })

  socket.on("join_as_agent", (data) => {
    const { agentName, agentId } = data

    const socketOrigin = socketOrigins.get(socket.id)
    const isAuthorizedOrigin = AGENT_ORIGINS.some((agentOrigin) => socketOrigin && socketOrigin.startsWith(agentOrigin))

    if (!isAuthorizedOrigin) {
      console.log(`🚫 Unauthorized agent connection attempt from: ${socketOrigin}`)
      socket.emit("error", {
        message: "Unauthorized: Agent connections must come from authorized domains",
      })
      return
    }

    console.log(`👨‍💼 Agent joined: ${agentName} (${agentId}) from ${socketOrigin}`)

    connectedAgents.set(socket.id, {
      agentId,
      agentName,
      socketId: socket.id,
      origin: socketOrigin,
      connectedAt: new Date().toISOString(),
    })

    // Enviar todos los chats activos al agente
    const chats = Array.from(activeChats.values())
    socket.emit("active_chats", chats)

    console.log(`✅ Sent ${chats.length} active chats to agent ${agentName}`)
  })

  socket.on("message_from_agent", (data) => {
    const { chatId, message, agentName } = data

    console.log(`💬 Agent message to chat ${chatId}: ${message.content}`)

    const chat = activeChats.get(chatId)
    if (!chat) {
      console.log(`❌ Chat not found: ${chatId}`)
      return
    }

    const messageData = {
      id: generateShortId("msg"),
      content: message.content,
      sender: "agent",
      senderName: agentName,
      time: message.time || new Date().toISOString(),
    }

    // Guardar mensaje en el chat
    chat.messages.push(messageData)

    // Asignar agente al chat si no está asignado
    if (!chat.agent) {
      chat.agent = agentName
      socket.to(chatId).emit("agent_joined", {
        chatId,
        agent: { name: agentName },
      })
    }

    // Enviar mensaje a todos en la sala
    io.to(chatId).emit("new_message", {
      chatId,
      message: messageData,
    })

    console.log(`✅ Agent message sent to chat ${chatId}`)

    updateChatActivity(chatId)
  })

  socket.on("agent_typing", (data) => {
    const { chatId } = data
    console.log(`⌨️ Agent typing in chat: ${chatId}`)

    // Notificar al usuario en ese chat
    socket.to(chatId).emit("agent_typing", { chatId })
  })

  socket.on("agent_stop_typing", (data) => {
    const { chatId } = data
    console.log(`✋ Agent stopped typing in chat: ${chatId}`)

    // Notificar al usuario en ese chat
    socket.to(chatId).emit("agent_stop_typing", { chatId })
  })

  socket.on("update_user_info", (data) => {
    const { chatId, userName, userEmail, userPhone } = data

    console.log(`📝 Updating user info for chat: ${chatId}`)

    const chat = activeChats.get(chatId)
    if (chat) {
      chat.userName = userName || chat.userName
      chat.userEmail = userEmail || chat.userEmail
      chat.userPhone = userPhone || chat.userPhone

      // Notificar a los agentes
      socket.broadcast.emit("user_info_updated", {
        chatId,
        userName: chat.userName,
        userEmail: chat.userEmail,
        userPhone: chat.userPhone,
      })

      console.log(`✅ User info updated for chat ${chatId}`)
    }
  })

  socket.on("request_missed_messages", (data) => {
    const { chatId, lastMessageId } = data

    console.log(`📥 Requesting missed messages for chat ${chatId}`)

    const chat = activeChats.get(chatId)
    if (chat) {
      const lastIndex = chat.messages.findIndex((m) => m.id === lastMessageId)
      const missedMessages = lastIndex >= 0 ? chat.messages.slice(lastIndex + 1) : []

      socket.emit("missed_messages", {
        chatId,
        messages: missedMessages,
      })

      console.log(`✅ Sent ${missedMessages.length} missed messages`)
    }
  })

  socket.on("save_chat", async (data) => {
    const { chatId } = data

    console.log(`💾 Manual save requested by agent for chat: ${chatId}`)

    const chat = activeChats.get(chatId)
    if (chat) {
      const result = await saveChatToDatabase(chat)
      socket.emit("chat_saved", { chatId, success: result.success })
    } else {
      socket.emit("chat_saved", {
        chatId,
        success: false,
        error: "Chat not found",
      })
    }
  })

  socket.on("close_chat", async (data) => {
    const { chatId } = data

    console.log(`🔒 Agent closing chat: ${chatId}`)

    const chat = activeChats.get(chatId)
    if (chat) {
      // Guardar antes de cerrar
      await saveChatToDatabase(chat)

      // Limpiar timers
      if (chatSaveTimers.has(chatId)) {
        clearTimeout(chatSaveTimers.get(chatId))
        chatSaveTimers.delete(chatId)
      }

      // Remover de memoria
      activeChats.delete(chatId)
      chatLastActivity.delete(chatId)

      // Notificar a todos
      io.to(chatId).emit("chat_closed", { chatId })

      console.log(`✅ Chat closed and saved by agent: ${chatId}`)
    }
  })

  socket.on("disconnect", async () => {
    console.log(`📱 Disconnected: ${socket.id}`)

    socketOrigins.delete(socket.id)

    const agent = connectedAgents.get(socket.id)
    if (agent) {
      console.log(`👨‍💼 Agent disconnected: ${agent.agentName}`)

      // Guardar todos los chats donde este agente estaba asignado
      for (const [chatId, chat] of activeChats.entries()) {
        if (chat.agent === agent.agentName && chat.messages.length > 0) {
          console.log(`💾 Auto-saving chat ${chat.chatroom_id} due to agent disconnect`)
          await saveChatToDatabase(chat)
        }
      }

      connectedAgents.delete(socket.id)
    }

    for (const [chatId, chat] of activeChats.entries()) {
      if (chat.socketId === socket.id) {
        console.log(`👤 User disconnected from chat: ${chatId}`)

        // Solo notificar a los agentes, NO guardar
        socket.broadcast.emit("customer_disconnected", {
          chatId,
          userName: chat.userName,
        })
      }
    }
  })
})

httpServer.on("request", async (req, res) => {
  if (req.url === "/status" || req.url === "/status/") {
    try {
      const html = await readFile(join(__dirname, "public", "status.html"), "utf-8")
      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(html)
      return
    } catch (error) {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end("Status page not found")
      return
    }
  }

  if (req.url === "/api/status") {
    const uptime = Date.now() - serverStartTime
    const statusData = {
      status: "online",
      uptime: uptime,
      uptimeFormatted: formatUptime(uptime),
      activeChats: activeChats.size,
      connectedAgents: connectedAgents.size,
      totalMessages: Array.from(activeChats.values()).reduce((sum, chat) => sum + chat.messages.length, 0),
      chats: Array.from(activeChats.values()).map((chat) => ({
        id: chat.chatroom_id,
        userName: chat.userName,
        agent: chat.agent || "Unassigned",
        messageCount: chat.messages.length,
        createdAt: chat.createdAt,
      })),
      agents: Array.from(connectedAgents.values()).map((agent) => ({
        name: agent.agentName,
        id: agent.agentId,
        connectedAt: agent.connectedAt,
      })),
      config: {
        port: PORT,
      },
      timestamp: new Date().toISOString(),
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    })
    res.end(JSON.stringify(statusData))
    return
  }

  res.writeHead(404, { "Content-Type": "text/plain" })
  res.end("Not found")
})

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

// Iniciar servidor
httpServer.listen(PORT, () => {
  console.log(`✅ Socket.IO server running on http://localhost:${PORT}`)
  console.log(`📊 Active chats: ${activeChats.size}`)
  console.log(`👥 Connected agents: ${connectedAgents.size}`)
})

// Auto-guardado periódico
setInterval(async () => {
  console.log(`🔄 Running periodic auto-save check...`)

  const now = Date.now()
  let savedCount = 0

  for (const [chatId, chat] of activeChats.entries()) {
    // Solo guardar si tiene agente asignado
    if (!chat.agent) {
      continue
    }

    const lastActivity = chatLastActivity.get(chatId) || 0
    const inactiveTime = now - lastActivity

    // Si el chat tiene mensajes y ha estado inactivo por más del intervalo
    if (chat.messages.length > 0 && inactiveTime > AUTOSAVE_INTERVAL) {
      await saveChatToDatabase(chat)
      chatLastActivity.set(chatId, now)
      savedCount++
    }
  }

  if (savedCount > 0) {
    console.log(`✅ Periodic auto-save completed: ${savedCount} chats saved`)
  }
}, AUTOSAVE_INTERVAL)
