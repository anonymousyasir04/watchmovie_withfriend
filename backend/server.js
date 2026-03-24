const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>SyncStream Backend</title></head>
    <body style="font-family: Arial; text-align: center; margin-top: 50px;">
      <h1>🚀 SyncStream Backend is Running!</h1>
      <p>Socket.IO server active</p>
      <p>Rooms: ${rooms.size}</p>
      <p>Last ping: ${new Date().toISOString()}</p>
    </body>
    </html>
  `);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ['websocket', 'polling']
});

// In-memory storage
const rooms = new Map(); // roomId -> { adminId, members: [userId], videoUrl, isPlaying, currentTime, speed }
const userSockets = new Map(); // socketId -> { userId, username, roomId }

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userId, username }) => {
    socket.join(roomId);
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        adminId: userId,
        members: [userId],
        videoUrl: null,
        isPlaying: false,
        currentTime: 0,
        speed: 1
      });
    } else {
      const room = rooms.get(roomId);
      if (!room.members.includes(userId)) {
        room.members.push(userId);
      }
    }
    userSockets.set(socket.id, { userId, username, roomId });

    const room = rooms.get(roomId);
    socket.emit('room-state', {
      adminId: room.adminId,
      videoUrl: room.videoUrl,
      isPlaying: room.isPlaying,
      currentTime: room.currentTime,
      speed: room.speed
    });
    socket.to(roomId).emit('user-joined', { username, userId });
    io.to(roomId).emit('users-list', room.members);
    console.log(`User ${username} joined room ${roomId}, members: ${room.members.length}`);
  });

  socket.on('leave-room', () => {
    const user = userSockets.get(socket.id);
    if (!user) return;
    const { userId, username, roomId } = user;
    const room = rooms.get(roomId);
    if (room) {
      room.members = room.members.filter(id => id !== userId);
      io.to(roomId).emit('user-left', { userId });
      io.to(roomId).emit('users-list', room.members);
      if (room.members.length === 0) {
        rooms.delete(roomId);
        console.log(`Room ${roomId} deleted (empty)`);
      } else if (room.adminId === userId) {
        // Transfer admin to the first member in list
        const newAdminId = room.members[0];
        room.adminId = newAdminId;
        io.to(roomId).emit('admin-transferred', newAdminId);
        console.log(`Admin transferred to ${newAdminId} in room ${roomId}`);
      }
    }
    userSockets.delete(socket.id);
    console.log(`User ${username} left room ${roomId}`);
  });

  // Video sync events (only if sender is admin)
  socket.on('play-video', ({ roomId, videoUrl }) => {
    const user = userSockets.get(socket.id);
    const room = rooms.get(roomId);
    if (room && user && room.adminId === user.userId) {
      room.videoUrl = videoUrl;
      room.isPlaying = true;
      socket.to(roomId).emit('sync-play', { videoUrl });
      console.log(`Play video in ${roomId}: ${videoUrl}`);
    }
  });

  socket.on('pause-video', ({ roomId }) => {
    const user = userSockets.get(socket.id);
    const room = rooms.get(roomId);
    if (room && user && room.adminId === user.userId) {
      room.isPlaying = false;
      socket.to(roomId).emit('sync-pause');
    }
  });

  socket.on('seek-video', ({ roomId, time }) => {
    const user = userSockets.get(socket.id);
    const room = rooms.get(roomId);
    if (room && user && room.adminId === user.userId) {
      room.currentTime = time;
      socket.to(roomId).emit('sync-seek', { time });
    }
  });

  socket.on('change-speed', ({ roomId, speed }) => {
    const user = userSockets.get(socket.id);
    const room = rooms.get(roomId);
    if (room && user && room.adminId === user.userId) {
      room.speed = speed;
      socket.to(roomId).emit('sync-speed', { speed });
    }
  });

  // Chat message
  socket.on('send-message', ({ roomId, username, message, emoji, color }) => {
    const content = message || emoji;
    if (content) {
      io.to(roomId).emit('new-message', {
        username,
        content,
        timestamp: new Date().toISOString(),
        color
      });
      console.log(`Message in ${roomId} from ${username}: ${content}`);
    }
  });

  // Voice signaling (simplified)
  socket.on('voice-join', ({ roomId }) => {
    socket.to(roomId).emit('voice-user-joined', { userId: userSockets.get(socket.id)?.userId });
  });
  socket.on('voice-leave', ({ roomId }) => {
    socket.to(roomId).emit('voice-user-left', { userId: userSockets.get(socket.id)?.userId });
  });
  socket.on('voice-offer', ({ to, offer }) => {
    socket.to(to).emit('voice-offer', { from: socket.id, offer });
  });
  socket.on('voice-answer', ({ to, answer }) => {
    socket.to(to).emit('voice-answer', { from: socket.id, answer });
  });
  socket.on('voice-ice', ({ to, candidate }) => {
    socket.to(to).emit('voice-ice', { from: socket.id, candidate });
  });

  // Admin actions
  socket.on('mute-participant', ({ roomId, userId }) => {
    const user = userSockets.get(socket.id);
    const room = rooms.get(roomId);
    if (room && user && room.adminId === user.userId) {
      io.to(roomId).emit('mute-participant', { userId });
    }
  });

  socket.on('kick-participant', ({ roomId, userId }) => {
    const user = userSockets.get(socket.id);
    const room = rooms.get(roomId);
    if (room && user && room.adminId === user.userId) {
      // Find socket of that user and disconnect them
      for (const [sockId, data] of userSockets.entries()) {
        if (data.userId === userId && data.roomId === roomId) {
          const targetSocket = io.sockets.sockets.get(sockId);
          if (targetSocket) {
            targetSocket.emit('kicked');
            targetSocket.disconnect(true);
          }
          break;
        }
      }
    }
  });

  socket.on('disconnect', () => {
    const user = userSockets.get(socket.id);
    if (user) {
      // Trigger leave logic
      socket.emit('leave-room'); // simulate leave
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});