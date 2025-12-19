import { Events } from "discord.js";
import { getRequiredEnv } from "../config/env.js";

const welcomeMessages = new Map();

export function registerMemberHandlers(client) {
  client.on(Events.GuildMemberAdd, async member => {
    await assignUserRole(member);
    await sendWelcomeMessage(member);
  });

  client.on(Events.GuildMemberRemove, async member => {
    await cleanupWelcomeMessage(member);
  });
}

async function assignUserRole(member) {
  const userRole = member.guild.roles.cache.find(
    role => role.name.toLowerCase() === "user"
  );

  if (!userRole) return;

  try {
    await member.roles.add(userRole);
  } catch (err) {
    console.error("Error assigning user role:", err);
  }
}

async function sendWelcomeMessage(member) {
  const channelId = getRequiredEnv("WELCOME_CHANNEL_ID");
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;

  const message = await channel.send(
    `Welcome to the **TarkovTracker.org** Discord server ${member}.`
  );

  welcomeMessages.set(member.id, message.id);
}

async function cleanupWelcomeMessage(member) {
  const channelId = getRequiredEnv("WELCOME_CHANNEL_ID");
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;

  const messageId = welcomeMessages.get(member.id);
  if (!messageId) return;

  try {
    const message = await channel.messages.fetch(messageId);
    await message.delete();
  } catch (err) {
    console.error("Failed to delete welcome message:", err);
  } finally {
    welcomeMessages.delete(member.id);
  }
}
