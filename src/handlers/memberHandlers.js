import { Events } from "discord.js";
import { getRequiredEnv } from "../config/env.js";
import { getDestinationId } from "../config/destinations.js";

// In-memory map of guild and member to the original welcome channel and message IDs.
// Limitation: on bot restart this map is empty, so welcome messages for
// members who joined before the restart cannot be deleted when they leave.
// Acceptable at this scale; persist to a store if orphaned messages become
// a problem.
const welcomeMessages = new Map();

export function registerMemberHandlers(client) {
  client.on(Events.GuildMemberAdd, async member => {
    try {
      await assignJoinRoles(member);
      await sendWelcomeMessage(member);
    } catch (err) {
      console.error("Member join handler failed", { code: err?.code ?? "unknown" });
    }
  });

  client.on(Events.GuildMemberRemove, async member => {
    try {
      await cleanupWelcomeMessage(member);
    } catch (err) {
      console.error("Member leave handler failed", { code: err?.code ?? "unknown" });
    }
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
  const channelId = getDestinationId(member.guild.id, "welcome");
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return;

  const message = await channel.send({
    content: `Welcome to the **TarkovTracker.org** Discord server ${member}.`,
    allowedMentions: { parse: [], users: [member.id] }
  });

  welcomeMessages.set(`${member.guild.id}:${member.id}`, { channelId, messageId: message.id });
}

async function cleanupWelcomeMessage(member) {
  const key = `${member.guild.id}:${member.id}`;
  const entry = welcomeMessages.get(key);
  if (!entry) return;

  try {
    const channel = member.guild.channels.cache.get(entry.channelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(entry.messageId);
    await message.delete();
  } catch (err) {
    console.error("Failed to delete welcome message", { code: err?.code ?? "unknown" });
  } finally {
    if (welcomeMessages.get(key) === entry) welcomeMessages.delete(key);
  }
}
