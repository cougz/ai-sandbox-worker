// ─── CUSTOMIZE THIS FILE ──────────────────────────────────────────────────────
//
// Define the TypeScript RPC tools that are available inside the sandbox.
// These become the `codemode.*` namespace — the LLM writes code like:
//
//   async () => {
//     const result = await codemode.search({ query: "something" });
//     await codemode.save({ key: "output", value: result });
//     return result;
//   }
//
// Each tool's `execute` function runs in the HOST Worker (not the sandbox),
// so it has full access to env bindings, external APIs, secrets, etc.
// The sandbox only sees the return value — it cannot access host internals.
//
// TOOL FORMAT:
//   - execute receives a single object argument (destructured below)
//   - Use `positionalArgs: true` in the ToolProvider if you prefer positional style
//   - Return value must be JSON-serializable
//
// ─────────────────────────────────────────────────────────────────────────────

export type DomainTools = typeof domainTools;

export const domainTools = {
  // Confluence Wiki Markup Generator
  // Converts Markdown/HTML/text to Confluence markup format

  confluence_markup_generator: {
    description: "Convert various content formats (Markdown, HTML, structured data, or text) into Confluence Wiki Markup format. Supports headings, tables, code blocks, lists, links, panels, and other common Confluence formatting elements.",
    execute: async ({ 
      content, 
      format = 'markdown', 
      title, 
      include_toc = false, 
      output_file 
    }: { 
      content: string;
      format?: string;
      title?: string;
      include_toc?: boolean;
      output_file?: string;
    }): Promise<Record<string, unknown>> => {
      // Confluence Wiki Markup conversion utilities
      const converters = {
        convertHeadings(text: string): string {
          return text
            .replace(/^######\s+(.+)$/gm, 'h6. $1')
            .replace(/^#####\s+(.+)$/gm, 'h5. $1')
            .replace(/^####\s+(.+)$/gm, 'h4. $1')
            .replace(/^###\s+(.+)$/gm, 'h3. $1')
            .replace(/^##\s+(.+)$/gm, 'h2. $1')
            .replace(/^#\s+(.+)$/gm, 'h1. $1');
        },
        
        convertFormatting(text: string): string {
          return text
            .replace(/\*\*\*([^\*]+)\*\*\*/g, '*_$1_*')
            .replace(/\*\*([^\*]+)\*\*/g, '*$1*')
            .replace(/\*([^\*]+)\*/g, '_$1_')
            .replace(/__([^_]+)__/g, '*$1*')
            .replace(/_([^_]+)_/g, '_$1_');
        },
        
        convertCodeBlocks(text: string): string {
          return text.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
            const language = lang || 'text';
            return `{code:${language}}\n${code.trim()}\n{code}`;
          });
        },
        
        convertInlineCode(text: string): string {
          return text.replace(/`([^`]+)`/g, '{{$1}}');
        },
        
        convertLinks(text: string): string {
          return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]');
        },
        
        convertTables(text: string): string {
          const lines = text.split('\n');
          const result: string[] = [];
          let inTable = false;
          let tableBuffer: string[][] = [];
          
          for (const line of lines) {
            if (line.startsWith('|')) {
              if (!inTable) {
                inTable = true;
                tableBuffer = [];
              }
              if (!line.match(/^\|[-\s|]+\|$/)) {
                const cells = line.split('|').slice(1, -1);
                const cleanedCells = cells.map(c => c.trim());
                if (cleanedCells.length > 0 && cleanedCells.some(c => c.length > 0)) {
                  tableBuffer.push(cleanedCells);
                }
              }
            } else {
              if (inTable) {
                if (tableBuffer.length > 0) {
                  result.push(this.renderConfluenceTable(tableBuffer));
                }
                inTable = false;
                tableBuffer = [];
              }
              result.push(line);
            }
          }
          
          if (inTable && tableBuffer.length > 0) {
            result.push(this.renderConfluenceTable(tableBuffer));
          }
          
          return result.join('\n');
        },
        
        renderConfluenceTable(rows: string[][]): string {
          if (rows.length === 0) return '';
          const result: string[] = [];
          result.push('\n||' + rows[0].join('||') + '||');
          for (let i = 1; i < rows.length; i++) {
            result.push('|' + rows[i].join('|') + '|');
          }
          return result.join('\n');
        },
        
        convertLists(text: string): string {
          const lines = text.split('\n');
          const result: string[] = [];
          
          for (const line of lines) {
            const orderedMatch = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
            const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
            
            if (orderedMatch) {
              const [, indent, , content] = orderedMatch;
              const level = Math.floor(indent.length / 2) + 1;
              result.push('#'.repeat(level) + ' ' + content);
            } else if (unorderedMatch) {
              const [, indent, content] = unorderedMatch;
              const level = Math.floor(indent.length / 2) + 1;
              result.push('*'.repeat(level) + ' ' + content);
            } else {
              result.push(line);
            }
          }
          
          return result.join('\n');
        },
        
        convertBlockquotes(text: string): string {
          return text.replace(/^>\s+(.+)$/gm, (match, content) => {
            return `{quote}\n${content}\n{quote}`;
          });
        },
        
        convertHorizontalRules(text: string): string {
          return text.replace(/^(---|___|\*\*\*)$/gm, '----');
        },
        
        convertStrikethrough(text: string): string {
          return text.replace(/~~([^~]+)~~/g, '-$1-');
        },
        
        convertFromHTML(html: string): string {
          let text = html
            .replace(/<h1[^>]*>([^<]*)<\/h1>/gi, 'h1. $1')
            .replace(/<h2[^>]*>([^<]*)<\/h2>/gi, 'h2. $1')
            .replace(/<h3[^>]*>([^<]*)<\/h3>/gi, 'h3. $1')
            .replace(/<h4[^>]*>([^<]*)<\/h4>/gi, 'h4. $1')
            .replace(/<h5[^>]*>([^<]*)<\/h5>/gi, 'h5. $1')
            .replace(/<h6[^>]*>([^<]*)<\/h6>/gi, 'h6. $1')
            .replace(/<strong[^>]*>([^<]*)<\/strong>/gi, '*$1*')
            .replace(/<b[^>]*>([^<]*)<\/b>/gi, '*$1*')
            .replace(/<em[^>]*>([^<]*)<\/em>/gi, '_$1_')
            .replace(/<i[^>]*>([^<]*)<\/i>/gi, '_$1_')
            .replace(/<code[^>]*>([^<]*)<\/code>/gi, '{{$1}}')
            .replace(/<pre[^>]*>([^<]*)<\/pre>/gi, '{code}\n$1\n{code}')
            .replace(/<a[^>]+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '[$2|$1]')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<p[^>]*>([^<]*)<\/p>/gi, '\n$1\n')
            .replace(/<li[^>]*>([^<]*)<\/li>/gi, '* $1')
            .replace(/<ul[^>]*>([^<]*)<\/ul>/gi, '$1')
            .replace(/<ol[^>]*>([^<]*)<\/ol>/gi, '$1')
            .replace(/<[^>]+>/g, '');
          return text;
        }
      };
      
      let confluenceContent = content;
      
      if (format === 'html') {
        confluenceContent = converters.convertFromHTML(content);
      } else if (format === 'markdown' || format === 'text') {
        confluenceContent = converters.convertCodeBlocks(confluenceContent);
        confluenceContent = converters.convertTables(confluenceContent);
        confluenceContent = converters.convertHeadings(confluenceContent);
        confluenceContent = converters.convertLists(confluenceContent);
        confluenceContent = converters.convertBlockquotes(confluenceContent);
        confluenceContent = converters.convertLinks(confluenceContent);
        confluenceContent = converters.convertFormatting(confluenceContent);
        confluenceContent = converters.convertInlineCode(confluenceContent);
        confluenceContent = converters.convertHorizontalRules(confluenceContent);
        confluenceContent = converters.convertStrikethrough(confluenceContent);
      }
      
      let output = '';
      
      if (include_toc) {
        output += '{toc}\n\n';
      }
      
      if (title) {
        output += `h1. ${title}\n\n`;
      }
      
      output += confluenceContent;
      
      const result: Record<string, unknown> = {
        success: true,
        content: output,
        word_count: output.split(/\s+/).length,
        char_count: output.length
      };
      
      if (output_file) {
        result.message = `Confluence markup ready. Save to: ${output_file}`;
      }
      
      return result;
    },
  },

  // ── DEPRECATED: KV stubs ──────────────────────────────────────────────────
  // These exist to satisfy the codemode.* interface contract but do NOT persist
  // data.  Use state.writeFile / state.readFile instead for durable storage.
  // Kept as stubs (not removed) because @cloudflare/codemode auto-registers
  // them — removing them from domainTools would require upstream changes.

  kvGet: {
    description:
      "DEPRECATED — does not persist data. Use state.readFile / state.readJson instead. Returns null for all keys.",
    execute: async ({ key }: { key: string }): Promise<string | null> => {
      console.warn(`[kvGet] DEPRECATED stub called for key="${key}" — use state.readFile instead`);
      return null;
    },
  },

  kvSet: {
    description:
      "DEPRECATED — does not persist data. Use state.writeFile / state.writeJson instead. Silently discards.",
    execute: async ({ key, value }: { key: string; value: string }): Promise<void> => {
      console.warn(`[kvSet] DEPRECATED stub called for key="${key}" — use state.writeFile instead. Value discarded.`);
    },
  },

  kvList: {
    description:
      "DEPRECATED — does not persist data. Use state.glob instead. Always returns empty array.",
    execute: async ({ prefix }: { prefix?: string }): Promise<string[]> => {
      console.warn(`[kvList] DEPRECATED stub called with prefix="${prefix ?? ""}" — use state.glob instead`);
      return [];
    },
  },

  kvDelete: {
    description:
      "DEPRECATED — does not persist data. Use state.rm instead. No-op.",
    execute: async ({ key }: { key: string }): Promise<void> => {
      console.warn(`[kvDelete] DEPRECATED stub called for key="${key}" — use state.rm instead`);
    },
  },
};

// ─── TypeScript interface shown to the LLM ───────────────────────────────────
// This is auto-generated by @cloudflare/codemode from the tool descriptors.
// You don't need to maintain this manually — it's here for reference.
//
// declare const codemode: {
//   kvGet(args: { key: string }): Promise<string | null>;
//   kvSet(args: { key: string; value: string }): Promise<void>;
//   kvList(args: { prefix?: string }): Promise<string[]>;
//   kvDelete(args: { key: string }): Promise<void>;
// }
