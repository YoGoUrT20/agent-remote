import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { sanitizeDiscordCredential } from "../discord-input.js";
import { bunRestOptions } from "./bun-rest.js";

export function buildSlashCommandBodies(): ReturnType<SlashCommandBuilder["toJSON"]>[] {
  const install = new SlashCommandBuilder()
    .setName("install")
    .setDescription("Provision this server for agent-remote")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const project = new SlashCommandBuilder()
    .setName("project")
    .setDescription("Manage agent-remote project channels")
    .addSubcommand((s) =>
      s
        .setName("open")
        .setDescription("Open a project chat channel under this IDE section (one per project per category)")
        .addStringOption((o) =>
          o
            .setName("name")
            .setDescription("Project folder — select from workspace subfolders")
            .setRequired(false)
            .setAutocomplete(true),
        ),
    );

  const settings = new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Open the agent-remote access-control panel (owner only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  return [install.toJSON(), project.toJSON(), settings.toJSON()];
}

export async function deployGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
): Promise<void> {
  const clean = sanitizeDiscordCredential(token).replace(/^(Bot|Bearer)\s*/i, "");
  const rest = new REST({ version: "10", ...bunRestOptions() }).setToken(clean);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
    body: buildSlashCommandBodies(),
  });
}
