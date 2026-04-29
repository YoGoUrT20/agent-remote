import {
  Client,
  EmbedBuilder,
  Events,
  MessageFlags,
  type RepliableInteraction,
} from "discord.js";
import { isUserAllowed } from "../../access-store.js";
import { BOT_COMMANDS_CHANNEL } from "../../constants.js";
import {
  currentAccess,
  isIgnorableInteractionError,
  isSettingsInteraction,
  MODEL_SELECT_ID,
  PROJECT_CREATE_NO,
  PROJECT_CREATE_YES,
  PROJECT_OPEN_SELECT_ID,
  replyBlockedByWhitelist,
  SETTINGS_ADD_ALLOWED,
  SETTINGS_CLAIM_OWNER,
  SETTINGS_CLEAR_ALLOWED,
  SETTINGS_DETECT_OWNER,
  SETTINGS_MODEL_RESET,
  SETTINGS_MODEL_SELECT,
  SETTINGS_REFRESH,
  SETTINGS_REMOVE_ALLOWED,
  SETTINGS_REMOVE_OWNER,
  SETTINGS_SET_OWNER,
  SETTINGS_TAB_ACCESS,
  SETTINGS_TAB_MODELS,
  SETTINGS_TOGGLE_RESTRICT,
} from "./utils.js";
import {
  handleSettingsCommand,
  handleSettingsUserSelect,
  handleSettingsRemoveAllowed,
  handleSettingsButtons,
  handleSettingsTabNavigation,
  handleSettingsModelReset,
  handleSettingsModelSelect,
} from "./settings.js";
import {
  handleProjectOpenCommand,
  handleProjectOpenSelect,
  handleProjectCreateConfirm,
  handleProjectCreateCancel,
} from "./project.js";
import { handleModelCommand, handleModelSelectMenu } from "./model.js";
import { handleInstallCommand, handleInstallConfirm, handleInstallCancel } from "./install.js";
import { handleProjectOpenAutocomplete, handleModelAutocomplete } from "./autocomplete.js";
import { registerMessageHandler } from "./messages.js";

export function registerHandlers(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      /* ── Autocomplete ── */
      if (interaction.isAutocomplete()) {
        if (
          interaction.commandName === "project" &&
          interaction.options.getSubcommand() === "open"
        ) {
          await handleProjectOpenAutocomplete(client, interaction);
          return;
        }
        if (interaction.commandName === "model") {
          await handleModelAutocomplete(client, interaction);
          return;
        }
        await interaction.respond([]);
        return;
      }

      /* Whitelist gate — applies to every interaction except /settings (so the
         owner can always manage access). */
      if (!isSettingsInteraction(interaction)) {
        const access = currentAccess(client);
        if (!isUserAllowed(interaction.user.id, access)) {
          if (interaction.isRepliable()) {
            await replyBlockedByWhitelist(interaction as RepliableInteraction, access);
          }
          return;
        }
      }

      /* ── Settings: user select menus ── */
      if (interaction.isUserSelectMenu()) {
        if (
          interaction.customId === SETTINGS_SET_OWNER ||
          interaction.customId === SETTINGS_ADD_ALLOWED
        ) {
          await handleSettingsUserSelect(client, interaction);
          return;
        }
      }

      /* ── Settings: remove allowed select menu ── */
      if (interaction.isStringSelectMenu() && interaction.customId === SETTINGS_REMOVE_ALLOWED) {
        await handleSettingsRemoveAllowed(client, interaction);
        return;
      }

      /* ── Settings: action buttons ── */
      if (
        interaction.isButton() &&
        (interaction.customId === SETTINGS_TOGGLE_RESTRICT ||
          interaction.customId === SETTINGS_CLEAR_ALLOWED ||
          interaction.customId === SETTINGS_CLAIM_OWNER ||
          interaction.customId === SETTINGS_REMOVE_OWNER ||
          interaction.customId === SETTINGS_DETECT_OWNER ||
          interaction.customId === SETTINGS_REFRESH)
      ) {
        await handleSettingsButtons(client, interaction);
        return;
      }

      /* ── Settings tab navigation ── */
      if (
        interaction.isButton() &&
        (interaction.customId === SETTINGS_TAB_ACCESS || interaction.customId === SETTINGS_TAB_MODELS)
      ) {
        await handleSettingsTabNavigation(client, interaction);
        return;
      }

      /* ── Settings model reset buttons ── */
      if (interaction.isButton() && interaction.customId.startsWith(SETTINGS_MODEL_RESET)) {
        await handleSettingsModelReset(client, interaction);
        return;
      }

      /* ── Settings model select menus ── */
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith(SETTINGS_MODEL_SELECT)) {
        await handleSettingsModelSelect(client, interaction);
        return;
      }

      /* ── Project create confirm/cancel buttons ── */
      if (interaction.isButton()) {
        if (interaction.customId.startsWith(PROJECT_CREATE_YES)) {
          await handleProjectCreateConfirm(client, interaction);
          return;
        }
        if (interaction.customId.startsWith(PROJECT_CREATE_NO)) {
          await handleProjectCreateCancel(client, interaction);
          return;
        }
        if (interaction.customId === "ar_install_confirm") {
          await handleInstallConfirm(client, interaction);
          return;
        }
        if (interaction.customId === "ar_install_cancel") {
          await handleInstallCancel(client, interaction);
          return;
        }
      }

      /* ── Model select menu ── */
      if (interaction.isStringSelectMenu() && interaction.customId === MODEL_SELECT_ID) {
        await handleModelSelectMenu(client, interaction);
        return;
      }

      /* ── Project open select menu ── */
      if (interaction.isStringSelectMenu() && interaction.customId === PROJECT_OPEN_SELECT_ID) {
        await handleProjectOpenSelect(client, interaction);
        return;
      }

      /* ── Slash commands ── */
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "install") {
        await handleInstallCommand(client, interaction);
        return;
      }

      if (interaction.commandName === "settings") {
        await handleSettingsCommand(client, interaction);
        return;
      }

      if (interaction.commandName === "model") {
        await handleModelCommand(client, interaction);
        return;
      }

      if (interaction.commandName === "project" && interaction.options.getSubcommand() === "open") {
        await handleProjectOpenCommand(client, interaction);
        return;
      }

      const fallback = new EmbedBuilder()
        .setTitle("Command")
        .setDescription(
          `No handler for \`/${interaction.commandName}\`. Use \`/install\` to provision the server, \`/project open\` from \`#${BOT_COMMANDS_CHANNEL}\`, then send a message in a project channel.`,
        )
        .setColor(0x5865f2);
      await interaction.reply({ embeds: [fallback], flags: MessageFlags.Ephemeral });
    } catch (e) {
      if (isIgnorableInteractionError(e)) return;
      console.error(e);
      try {
        if (!interaction.isRepliable()) return;
        const errEmb = new EmbedBuilder()
          .setTitle("Error")
          .setDescription(
            "Could not complete this interaction. Check the bot process logs or run `agent-remote setup` again.",
          )
          .setColor(0xed4245);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            embeds: [errEmb],
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.editReply({ embeds: [errEmb] });
        }
      } catch (errReply) {
        if (isIgnorableInteractionError(errReply)) return;
      }
    }
  });

  registerMessageHandler(client);
}
