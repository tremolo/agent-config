/**
 * Sushi Quick Look Extension
 * 
 * Adds Ctrl+Shift+R to open the latest file reference in sushi (Linux file viewer)
 */

import { Key } from '@mariozechner/pi-tui';

export default function () {
  return {
    name: 'sushi-quicklook',
    
    commands: {
      quickLookWithSushi: {
        description: 'Open latest file reference in sushi viewer',
        async execute(ctx) {
          const session = ctx.session;
          
          // Get all messages from the session
          const messages = session.getMessages();
          
          // Find the latest @filename reference in user or assistant messages
          let latestFile: string | null = null;
          
          for (const msg of messages) {
            if (!msg.content) continue;
            
            // Match @filename pattern (common file references in pi)
            const filenameMatches = msg.content.match(/@([^'"<>][^'"\s]*)/g);
            if (filenameMatches) {
              for (const match of filenameMatches) {
                const fileName = match.substring(1).trim(); // Remove the @ and trim
                // Only consider valid file paths (not URLs, not commands)
                if (!fileName.startsWith('http') && 
                    !fileName.includes('://') && 
                    !fileName.startsWith('/') &&
                    fileName.length > 0 &&
                    fileName.length < 500) {
                  latestFile = fileName;
                }
              }
            }
          }
          
          if (!latestFile) {
            ctx.ui.notify('No file reference found in session to open with sushi', 'warning');
            return;
          }
          
          // Use bash tool to open sushi
          await ctx.tools.bash.execute({
            command: `/usr/bin/sushi "${latestFile}"`
          });
        }
      }
    },
    
    register(pi) {
      pi.registerCommand('quick-look-sushi', this.commands.quickLookWithSushi);
      
      // Register custom shortcut for Ctrl+Shift+R
      pi.registerShortcut(Key.ctrlShift('r'), {
        description: 'Quick look at latest file with sushi',
        handler: async (ctx) => {
          await this.commands.quickLookWithSushi.execute(ctx);
        }
      });
    }
  };
}
