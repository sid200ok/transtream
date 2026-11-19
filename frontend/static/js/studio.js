// ──── MESSAGE INPUT AREA (CHAT WINDOW STYLE) ────
// Add message input functionality to Alpine store
document.addEventListener('alpine:init', () => {
  Alpine.store('tsStudio', {
    newMessage: '',
    placeholderText: 'Type your message here...',

    sendMessage() {
      if (this.pipelineBusy() || !this.recording || !this.newMessage.trim()) return;

      // Simulate sending message to backend
      console.log('Sending:', this.newMessage);

      // Clear input
      this.newMessage = '';
    },

    pipelineBusy() {
      // Check if any pipeline activity is happening
      return ['recording', 'normalizing', 'vadRunning', 'transcribing'].some(state =>
        Alpine.store('studioRecorder').state === state
      );
    }
  });
});