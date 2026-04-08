import dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import * as Y from "yjs";
import { connectDB } from "./db/db.js";
import { User } from "./models/users.js";
import { Room } from "./models/rooms.js";
import { generateToken, verifyToken } from "./utils/generateToken.js";
import { OAuth2Client } from "google-auth-library";
import {
  loginLimiter,
  signInLimiter,
  createRoomLimiter,
  redisClient,
  contactLimiter,
} from "./utils/redisLimiter.js";
import { createChat } from "./ai_agent/AI.js";
import { canSendMessage, deleteRoom } from "./utils/chatLimiter.js";
import mongoose from "mongoose";

const ENV= process.env.ENV || "development";
const host = ENV === "production" ? "0.0.0.0" : "localhost";

connectDB();
const db = mongoose.connection;
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());
app.set("trust proxy", 1)

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const rooms = {};
const docs = new Map();
const socketRoomMap = new Map();

const now = () =>
  new Date()
    .toLocaleTimeString("en-US", {
      timeZone: "Asia/Kolkata",
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(":", "-");

function getYDoc(roomId) {
  let entry = docs.get(roomId);
  if (!entry) {
    const ydoc = new Y.Doc();
    entry = { ydoc };
    docs.set(roomId, entry);
  }
  return entry;
}

function updateRoomHistory(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  if (!room.hist) room.hist = [];
  room.hist.push({ time: now(), message });
  if (room.hist.length > 50) room.hist.shift();
}

const isOwner = (socket, room) => socket.id === room.owner?.socketId;

const result = await Room.deleteMany({});
console.log("Deleted inactive rooms:", result);

io.on("connection", (socket) => {
  console.log(`[Connected] Socket ID: ${socket.id}`);

  socket.on(
    "createRoom",
    async ({ newRoomId: roomId, name, token }, callback) => {
      try {
        const { verified, data } = await verifyToken(token);
        if (!verified)
          return callback?.({
            success: false,
            message: "Unauthorised request please re-Login",
          });
        const userDb = await User.findOne({ username: data.username });
        if (!userDb)
          return callback?.({ success: false, message: "User not found" });
        if (rooms[roomId])
          return callback?.({ success: false, message: "Room exists" });

        const allowed = await createRoomLimiter(
          name,
          redisClient,
          10,
          60 * 60 * 1000
        );
        if (!allowed)
          return callback?.({
            success: false,
            message: "Room creation limit reached. Try again later.",
          });

        const chat = createChat();
        rooms[roomId] = {
          name: `${name}'s Room`,
          users: {
            [name]: {
              canChat: true,
              canEdit: true,
              socketId: socket.id,
              isAdmin: true,
            },
          },
          sockets: { [name]: socket.id },
          lang: "javascript",
          owner: { id: data.id, name, socketId: socket.id },
          hist: [{ time: now(), message: `Room created by ${name}` }],
          setting: {
            enableChat: true,
            enableCollab: true,
            enableEditing: true,
          },
          chat,
          locked: false,
          lastEdit: Date.now(),
        };

        try {
          const newRoom = new Room({
            roomId,
            roomName: `${name}'s Room`,
            active: true,
            createdAt: new Date(),
          });
          await newRoom.save();
          await User.updateOne(
            { username: data.username },
            { $push: { roomsJoined: roomId } }
          );
        } catch (err) {
          console.error("[DB Error] Creating Room:", err);
        }

        socket.join(roomId);
        socketRoomMap.set(socket.id, roomId); 
        getYDoc(roomId);
        socket.emit("roomCreated", rooms[roomId].users);
        callback?.({ success: true, roomId, users: rooms[roomId].users ,roomName:rooms[roomId].name});
        console.log(`[Room Created] ${roomId} by ${name}`);
      } catch (err) {
        console.error("[CreateRoom Error]:", err);
        callback?.({ success: false, message: "Error creating the room" });
      }
    }
  );

  socket.on("joinRoom", async ({ roomID: roomId, name, token }, callback) => {
    try {
      const { verified, data } = await verifyToken(token);
      if (!verified)
        return callback?.({
          success: false,
          message: "Unauthorised request please re-Login",
        });
      const userDb = await User.findOne({ username: data.username });
      if (!userDb)
        return callback?.({ success: false, message: "User not found" });

      const room = rooms[roomId];
      if (!room) return socket.emit("error", "Room not found");
      if (!room.setting?.enableCollab)
        return socket.emit("error", "Collab disabled");
      if (room.users[name]) return socket.emit("error", "User already in room");

      const isAdmin = room.owner?.id === data.id;
      const canEdit = room.setting.enableEditing || isAdmin;
      const canChat = room.setting.enableChat || isAdmin;

      if (isAdmin) room.owner.socketId = socket.id;
      if (!userDb.roomsJoined.includes(roomId))
        await User.updateOne(
          { username: data.username },
          { $push: { roomsJoined: roomId } }
        );

      const { ydoc } = getYDoc(roomId);
      const update = Y.encodeStateAsUpdate(ydoc);
      room.users[name] = { canEdit, canChat, socketId: socket.id, isAdmin };
      room.sockets[name] = socket.id;

      socket.join(roomId);
      socketRoomMap.set(socket.id, roomId);
      socket.emit("yjs-update", { roomId, update });
      socket.emit("updateLang", room.lang);

      io.to(roomId).emit("userJoined", room.users);
      io.to(roomId).emit("collabToggled", room.setting.enableCollab);
      io.to(roomId).emit("chatToggled", room.setting.enableChat);
      io.to(roomId).emit("editToggled", room.setting.enableEditing);
      updateRoomHistory(roomId, `${name} joined`);

      callback?.({
        success: true,
        canEdit,
        canChat,
        collabEnabled: room.setting.enableCollab,
        isAdmin,
        users: room.users,
        roomName: room.name,
      });
      setTimeout(() => io.to(roomId).emit("yjs-init", { roomId, update }), 500);
      console.log(`[User Joined] ${name} joined ${roomId}`);
    } catch (err) {
      console.error("[JoinRoom Error]:", err);
      callback?.({ success: false, message: "Join failed" });
    }
  });

  socket.on("yjs-update", ({ roomId, update, from }) => {
    try {
      const room = rooms[roomId];
      if (!room) return;
      const user = room.users[from];
      if (!user || !user.canEdit) return;
      const binary = new Uint8Array(update);
      const { ydoc } = getYDoc(roomId);
      Y.applyUpdate(ydoc, binary);
      io.to(roomId).emit("yjs-update", { roomId, update: binary });
      room.lastEdit = Date.now();
    } catch (err) {
      console.error("[YJS Update Error]:", err);
    }
  });

  socket.on("changeLang", ({ roomId, lang }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room)) return;
    room.lang = lang;
    io.to(roomId).emit("updateLang", lang);
  });

  socket.on("sendMessage", async ({ roomId, chat }) => {
    try {
      const room = rooms[roomId];
      if (!room) return;
      const isAdmin = isOwner(socket, room);
      if (!room.setting?.enableChat && !isAdmin) return;
      const sender = await User.findOne({ username: chat.from });
      if (!sender || !room.users[chat.from]) return;
      io.to(roomId).emit("receiveMessage", chat);
    } catch (err) {
      console.error("[SendMessage Error]:", err);
    }
  });

  socket.on("toggleEditing", ({ roomId, edit }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room)) return;
    room.setting.enableEditing = edit;
    for (const user of Object.values(room.users))
      if (user.socketId !== room.owner.socketId) user.canEdit = edit;
    io.to(roomId).emit("editToggled", edit);
    io.to(roomId).emit("userUpdated", room.users);
  });

  socket.on("toggleChat", ({ roomId, chat }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room)) return;
    room.setting.enableChat = chat;
    for (const user of Object.values(room.users))
      if (user.socketId !== room.owner.socketId) user.canChat = chat;
    io.to(roomId).emit("chatToggled", chat);
    io.to(roomId).emit("userUpdated", room.users);
  });

  socket.on("toggleCollab", ({ roomId, collab }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room)) return;
    room.setting.enableCollab = collab;
    io.to(roomId).emit("collabToggled", collab);
  });

  socket.on("toggleUserEdit", ({ roomId, name, socketId, canEdit }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room) || !room.users[name]) return;
    room.users[name].canEdit = canEdit;
    io.to(socketId).emit("editToggled", canEdit);
    io.to(roomId).emit("updatedUserEdit", { [name]: room.users[name] });
  });

  socket.on("toggleUserChat", ({ roomId, name, socketId, canChat }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room) || !room.users[name]) return;
    if (socketId === room.owner.socketId) return;
    room.users[name].canChat = canChat;
    io.to(socketId).emit("chatToggled", canChat);
    io.to(roomId).emit("updatedUserChat", { [name]: room.users[name] });
  });

  socket.on("removeUser", ({ roomId, name, socketId }) => {
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room) || !room.users[name]) return;
    delete room.users[name];
    delete room.sockets[name];
    io.to(roomId).emit("userUpdated", room.users);
    io.to(socketId).emit("leave", { data: null });
  });

  socket.on("toAgent", async ({ roomId, message, code, lang, token, name }) => {
    try {
      const user = rooms[roomId]?.users[name];
      if (!user || !user.canChat) return;
      const continueSending = canSendMessage(socket.id);
      if (!continueSending) return;

      const { verified } = await verifyToken(token);
      if (!verified) return;

      const room = rooms[roomId];
      if (!room) return;

      const agent = room.chat;
      if (!agent) return;

      if (agent.history && agent.history.length > 15)
        agent.history = agent.history.slice(-10);

      const response = await agent.sendMessage({
        message: `message is : ${message}, language: ${lang}, code is : ${code}`,
      });
      if (!response) return io.to(roomId).emit("error", "Invalid AI response");

      const data = response.candidates[0].content.parts[0];
      const output =
        typeof data.text === "string" ? JSON.parse(data.text) : data.text;

      io.to(roomId).emit("fromAgent", {
        from: "ai",
        text: output.text,
        code: output.code,
        instructions: output.instructions,
      });
    } catch (err) {
      console.error("[AI Agent Error]:", err);
      io.to(roomId).emit("error", "Error sending message to agent");
    }
  });

  socket.on("changeRoomName",async ({ roomId, newName ,token}) => {
    const { verified ,data } = await verifyToken(token);
    const allowed=canSendMessage(roomId,5,60*60*1000);
    if(!allowed)return;
    if (!verified) return;
    const room = rooms[roomId];
    if (!room || !isOwner(socket, room)) return;
    room.name = newName;
    await Room.updateOne(
      { roomId },
      { roomName: newName }
    );
    console.log(`[Room Name Changed] ${roomId} to ${newName} by ${data.username}`);
    io.to(roomId).emit("roomNameChanged", newName);
  });

  socket.on("deleteRoom", async ({ roomId, token }) => {
    console.log(`[Delete Room Request] ${roomId}`);
    try {
      const { verified } = await verifyToken(token);
      if (!verified) return;
      const room = rooms[roomId];
      if (!room || !isOwner(socket, room) || room.locked) return;
      room.locked = true;
      deleteRoom(roomId);
      delete rooms[roomId];
      docs.delete(roomId);
      await Room.updateOne(
        { roomId },
        { active: false, inactiveAt: new Date() }
      );
      io.to(roomId).emit("leave", { roomId });
      console.log(`[Room Deleted] ${roomId}`);
    } catch (err) {
      console.error("[DeleteRoom Error]:", err);
    }
  });

socket.on("leavingRoom", async ({ roomId, token } = {}) => {
  console.log(`[Leaving Room Request] ${roomId}`);

  try {
    const room = rooms[roomId];
    if (!room) return;

    // Preferred: find username by socket.id (works even on unload/disconnect)
    let username = Object.keys(room.sockets).find(
      (k) => room.sockets[k] === socket.id
    );

    // Fallback: try token only if username not found
    if (!username && token) {
      try {
        const { verified, data } = await verifyToken(token);
        if (verified) username = data.username;
      } catch (err) {
        // ignore - we'll bail if no username found
      }
    }

    if (!username) {
      console.log(`[LeavingRoom] Could not resolve username for socket ${socket.id}`);
      return;
    }

    console.log(`[User Leaving] ${username} from ${roomId}`);

    // Normal user leave
    if (room.users[username]) {
      delete room.users[username];
      delete room.sockets[username];
      io.to(roomId).emit("userLeft", room.users);
      updateRoomHistory(roomId, `${username} left`);
      console.log(`[User Left] ${username} from ${roomId}`);
    }
  } catch (err) {
    console.error("[LeavingRoom Error]:", err);
  }
});

 socket.on("disconnect", async () => {
  console.log(`[Disconnected] Socket ID: ${socket.id}`);
  const roomId = socketRoomMap.get(socket.id);
  console.log(`[Disconnect] Socket ID: ${socket.id} was in Room: ${roomId}`);
  if (!roomId) return;
  const room = rooms[roomId];
  if (!room) {
    socketRoomMap.delete(socket.id);
    return;
  }
  console.log(`[Disconnect] Found Room: ${room.name} for Socket ID: ${socket.id}`);
  const username = Object.keys(room.sockets).find(
    (k) => room.sockets[k] === socket.id
  );
  console.log(`[Disconnected] Socket ID: ${socket.id} from Room: ${roomId}`);

  if (username) {
    delete room.users[username];
    delete room.sockets[username];
    io.to(roomId).emit("userLeft", room.users);
    updateRoomHistory(roomId, `${username} left`);
    console.log(`[User Left] ${username} from ${roomId}`);
  }

  socketRoomMap.delete(socket.id);

  // existing room-empty cleanup (keep as-is)
  if (room && Object.keys(room.users).length === 0 && !room.locked) {
    room.locked = true;
    deleteRoom(roomId);
    delete rooms[roomId];
    docs.delete(roomId);
    await Room.updateOne({ roomId }, { active: false, inactiveAt: new Date() })
      .catch((err) => console.error("[Room Cleanup Error]:", err));
    console.log(`[Room Cleanup] Deleted empty room ${roomId}`);
  }
});
});


app.get("/", async  (_, res) => {
  // ping redis and mongo to keep connections alive
  try {
    await User.findOne({});
    await redisClient.ping();
    res.send("Server is running");
  } catch (err) {
    res.status(503).send("Service Unavailable");
  }
}
);

app.head("/health", async (_, res) => {
  try {
    await User.findOne({});
    await redisClient.ping();
    res.status(200).end();
  } catch (err) {
    res.status(503).end();
  }
});

app.post("/checkRoom", (req, res) => {
  const { roomId } = req.body;
  const exists = !!rooms[roomId];
  res.json({ exists, users: exists ? rooms[roomId].users : {} });
});

app.post("/contact", contactLimiter, async (req, res) => {});

app.post("/pastRooms", async (req, res) => {
  const { token } = req.body;
  try {
    const { verified, data } = await verifyToken(token);
    if (!verified)
      return res
        .status(401)
        .json({ msg: "Unauthorised request please re-Login" });
    const userDb = await User.findOne({ username: data.username });
    if (!userDb) return res.status(404).json({ msg: "User not found" });
    const userRooms = userDb.roomsJoined;
    const roomData = await Room.find({ roomId: { $in: userRooms } });
    res.json({ rooms: roomData });
  } catch (err) {
    console.error("[GetRooms Error]:", err);
    res.status(500).json({ msg: "Error fetching rooms" });
  }
});

app.post("/register", signInLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ msg: "User exists" });
    const newUser = new User({ username, email, password });
    await newUser.save();
    res.status(201).json({ msg: "Registered" });
  } catch (err) {
    console.error("[Register Error]:", err);
    res.status(500).json({ msg: "Error" });
  }
});

app.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.json({ msg: "User not found" });
    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.json({ msg: "Invalid credentials" });
    const token = generateToken(user);
    res.status(200).json({ msg: "Login ok", token, user });
  } catch (err) {
    console.error("[Login Error]:", err);
    res.json({ msg: "Error" });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const { token } = req.body;
    const result = await verifyToken(token);
    res.json({ success: result.verified ?? false });
  } catch (err) {
    console.error("[Verify Error]:", err);
    res.status(400).json({ success: false });
  }
});

app.post("/google-login", async (req, res) => {
  try {
    const { token } = req.body;
    const result = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = result.getPayload();
    let userDb = await User.findOne({ email: payload.email });
    if (!userDb) {
      userDb = new User({
        username: payload.name,
        email: payload.email,
        password: "google",
        provider: "google",
        providerId: payload.sub,
      });
      await userDb.save();
    }
    const jwtToken = generateToken(userDb);
    res.json({ success: true, token: jwtToken, user: payload.name });
  } catch (err) {
    console.error("[Google Login Error]:", err);
    res.status(400).json({ success: false });
  }
});

setInterval(() => {
  for (const [roomId, room] of Object.entries(rooms)) {
    if (Object.keys(room.users).length === 0 && !room.locked) {
      room.locked = true;
      delete rooms[roomId];
      docs.delete(roomId);
      deleteRoom(roomId);
      Room.updateOne(
        { roomId },
        { active: false, inactiveAt: new Date() }
      ).catch((err) => console.error("[Room Cleanup Error]:", err));
      console.log(`[Interval Cleanup] Deleted empty room ${roomId}`);
    }
  }
}, 2 * 60 * 1000);

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const toDelete = await Room.find({
      active: false,
      inactiveAt: { $lte: cutoff },
    });
    for (const r of toDelete) {
      await Room.deleteOne({ roomId: r.roomId });
      await User.updateMany(
        { roomsJoined: r.roomId },
        { $pull: { roomsJoined: r.roomId } }
      );
      if (rooms[r.roomId]) {
        delete rooms[r.roomId];
        docs.delete(r.roomId);
        deleteRoom(r.roomId);
      }
      console.log(`[Inactive Room Deleted] ${r.roomId}`);
    }
  } catch (err) {
    console.error("[Inactive Rooms Cleanup Error]:", err);
  }
}, 10 * 60 * 1000);


process.on("unhandledRejection", (err) =>
  console.error("Unhandled Rejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("Uncaught Exception:", err)
);

const PORT = process.env.PORT || 8080;
server.listen(PORT,host, () =>
  console.log(`Server running on port ${PORT} : ${ENV=== "production" ? "https://server-p9j7.onrender.com/" : `http://${host}:${PORT}`} `)
);
