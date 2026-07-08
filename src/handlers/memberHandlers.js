import { Events } from "discord.js";
import { getRequiredEnv } from "../config/env.js";

// In-memory map of member ID -> welcome message ID.
// Limitation: on bot restart this map is empty, so welcome messages for
// members who joined before the restart cannot be deleted when they leave.
// Acceptable at this scale; persist to a store if orphaned messages become
// a problem.
const welcomeMessages = new Map();

export function registerMemberHandlers(client) {
  client.on(Events.GuildMemberAdd, async member => {
    await assignJoinRoles(member);
    await sendWelcomeMessage(member);
  });

  client.on(Events.GuildMemberRemove, async member => {
    await cleanupWelcomeMessage(member);
  });
}

async function assignJoinRoles(member) {
  const userRole = member.guild.roles.cache.find(
    role => role.name.toLowerCase() === "user"
  );

  const autoRoleIds = [
    getRequiredEnv("AUTO_ROLE_ID_1"),
    getRequiredEnv("AUTO_ROLE_ID_2"),
    getRequiredEnv("AUTO_ROLE_ID_3"),
    getRequiredEnv("AUTO_ROLE_ID_4")
  ];

  try {
    const rolesToAdd = new Set();

    if (userRole) {
      rolesToAdd.add(userRole);
    }

    for (const roleId of autoRoleIds) {
      const role = member.guild.roles.cache.get(roleId);
      if (role) {
        rolesToAdd.add(role);
      } else {
        console.warn(`Auto-role not found in guild: ${roleId}`);
      }
    }

    if (rolesToAdd.size === 0) return;
    await member.roles.add([...rolesToAdd]);
  } catch (err) {
    console.error("Error assigning join roles:", err);
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
