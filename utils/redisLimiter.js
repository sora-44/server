import dotenv from "dotenv";
dotenv.config();

import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { createClient } from 'redis';


const redisClient = createClient({
  socket: {
    host: process.env.redis_host,
    port: process.env.redis_port,
  },
  username: process.env.redis_username,
  password: process.env.redis_pass,
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));

await redisClient.connect();
console.log(' Connected to Redis Cloud!');

const loginLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }),
  windowMs: 30 * 60 * 1000,
  max: 5,
  message: { msg: 'Too many login attempts. Try again later.' },
});

const signInLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }),
  windowMs: 30 * 60 * 1000,
  max: 2,
  message: { msg: 'You can only sign in once per hour. Try again later.' },
});

const createRoomLimiter = async (userKey, redisClient, max = 10, windowMs = 60 * 1000) => {
  const key = `createRoom:${userKey}`;
  const current = await redisClient.get(key);

  if (current && Number(current) >= max) {
    return false;
  }

  if (current) {
    await redisClient.incr(key);
  } else {
    await redisClient.set(key, 1, { EX: Math.floor(windowMs / 1000) });
  }

  return true;
};

const contactLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
  }),
  windowMs: 24* 60 * 60 * 1000, 
  max: 1,
  message: { msg: 'Too many contact requests. Try again later.' },
});

export { redisClient, loginLimiter, signInLimiter, createRoomLimiter, contactLimiter };
