// /wipe command: Delete all messages in the channel with confirmation
async execute(interaction) {
  const adminIds = process.env.ADMIN_IDS.split(',');
  const userIsAdmin = adminIds.includes(interaction.user.id);

  if (!userIsAdmin) {
    return interaction.reply({ content: 'Only admins can use this command.', ephemeral: true });
  }

  const confirmMsg = await interaction.reply({ 
    content: 'Are you sure you want to delete all messages in this channel? This action cannot be undone.',
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            label: 'Confirm',
            style: 4,
            customId: 'confirm_wipe'
          }
        ]
      }
    ],
    ephemeral: true
  });

  const filter = i => i.user.id === interaction.user.id && i.customId === 'confirm_wipe';
  const collector = confirmMsg.createMessageComponentCollector({ filter, time: 15000 });

  collector.on('collect', async i => {
    try {
      const messages = await interaction.channel.messages.fetch({ limit: 100 });
      await interaction.channel.messages.bulkDelete(messages);
      await i.reply({ content: '✅ All messages deleted.', ephemeral: true });
    } catch (error) {
      console.error('Error wiping messages:', error);
      await i.reply({ content: '❌ Failed to delete messages.', ephemeral: true });
    }
  });

  collector.on('end', async () => {
    await confirmMsg.delete();
  });
}