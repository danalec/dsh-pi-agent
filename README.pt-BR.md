# dsh-pi-agent

[English](README.md) | [中文](README.zh.md) | Português (BR) | [日本語](README.ja.md) | [Español](README.es.md)

Execute o [Pi coding agent](https://github.com/earendil-works/pi) ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) como agent loop dentro do [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ([`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): um plugin `Agent` do DSH que conduz um processo filho `pi --mode rpc` sem interface, de modo que o frontend do DSH — log de sessão, hooks, presets, web UI — funciona sem alterações.

> **Procurando alguma destas coisas?**
> - *"Como uso o pi dentro do DeepSeek Harness / DSH?"* — você está no lugar certo.
> - *"Trocar o agent-loop do DSH pelo loop do pi coding agent?"* — este plugin substitui a fábrica por um processo filho `pi --mode rpc`.
> - *"Rodar o pi com uma web UI / frontend de navegador?"* — dsh-pi-agent + o app web oficial do DSH dá ao pi a interface web completa: persistência de sessão, hooks, presets, seleção de modelo.
> - *"Usar um prompt mínimo e limpo dentro do DSH?"* — o motor pi mantém seu prompt de sistema de ~300 tokens e suas quatro ferramentas; a montagem de prompt do DSH nunca chega ao modelo. Zero injeção de prompt.
> - *"Subagentes Claude Code / Codex dentro do DSH?"* — o DSH já suporta isso nativamente; este plugin adiciona o pi como opção de motor da mesma forma.

```
Frontend do DSH (sessões, hooks, presets, persistência SQLite, web UI)
        │
dsh-pi-agent  (este plugin: AgentFactory + tradução de eventos + passagem de histórico)
        │  spawn + JSONL sobre stdio
        │  comandos: set_model / prompt / steer / abort
        ▼
pi --mode rpc --session <histórico reconstruído>   (o agent loop do Pi, intacto)
```

A cada create/resume o plugin reconstrói um arquivo de sessão do Pi a partir do log de eventos durável do DSH e inicia o processo filho com `--session`, de modo que a janela de contexto do filho já contém a conversa completa — incluindo turnos que rodaram sob o loop nativo do DSH antes da troca (veja [Passagem de sessão em andamento](#passagem-de-sessão-em-andamento)).

## Por quê

Pi é um harness mínimo: um prompt de sistema de ~300 tokens, quatro ferramentas (`read`/`bash`/`edit`/`write`) e zero injeções no meio da sessão. DSH ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)) é uma plataforma baseada em plugins: sessões duráveis, políticas, cadeias de aprovação e um registro completo de montagem de prompt.

Este plugin te dá os dois de uma vez: **a casca de engenharia do DSH em volta do motor limpo do Pi.** Com o plugin ativo, o modelo vê exatamente o que veria rodando `pi` diretamente no mesmo diretório de trabalho — sem seções de prompt extras, sem ferramentas extras, sem lembretes ocultos. A montagem de prompt do próprio DSH (`dsh-system-prompt`) e sua superfície de ferramentas são totalmente contornadas nas sessões dirigidas por esta fábrica.

Ele também torna possível um experimento A/B limpo: mesmo frontend, mesmo formato de sessão, liga e desliga o plugin para comparar o loop nativo do DSH com o loop puro do Pi.

## O que muda e o que não muda

| Camada | Comportamento |
| --- | --- |
| Prompt de sistema / ferramentas / contexto | **Intocado** — idêntico a rodar `pi` no mesmo diretório (arquivos de contexto como `AGENTS.md` são carregados pelo próprio Pi) |
| Roteamento de modelo | `set_model` por sessão; o modelo pedido por um subagente delegado tem precedência sobre o padrão da fábrica. Um modelo sem provider empresta o provider do padrão — o campo de provider nunca recebe um id de modelo |
| Direção (steering) | `send(..., 'next-turn' \| 'next-step')` do DSH mapeia para o `steer` do Pi — injete instruções no meio da execução. A instrução é entregue ao loop em execução exatamente uma vez |
| Persistência de sessão | Os eventos de sessão do DSH continuam sendo a fonte durável da verdade; um arquivo de sessão do Pi é reconstruído a partir deles a cada create/resume, então o filho já inicia com todo o histórico |
| Aprovação / permissões | O modelo de confiança local do Pi se aplica — as chamadas de ferramenta do Pi não passam pela cadeia de aprovação do DSH |
| Fallback | Desabilite a entrada deste plugin e o `dsh-agent-loop` do próprio DSH volta a valer imediatamente |

## Mapeamento de fronteiras

A ponte traduz os internos do Pi para o modelo de turno/passo do DSH:

| DSH | Pi |
| --- | --- |
| um turno | um comando `prompt` (uma execução do Pi) |
| um passo | uma mensagem de assistente (uma chamada de modelo mais as execuções de ferramenta que ela pediu) |
| fronteira de passo | o evento `turn_end` do Pi (o turno do assistente terminou) |
| entrada de next-step | o comando `steer` do Pi (entregue logo antes da próxima chamada de LLM) |

Um turno fecha quando o Pi reporta `agent_settled` — e não em `agent_end`, que apenas encerra uma execução de baixo nível enquanto retentativas, recuperação de compactação e trabalho enfileirado ainda podem vir a seguir.

## Hooks de agente do DSH

O plugin implementa os eventos de agente dos quais o frontend e a cadeia de políticas dependem:

| Evento | Comportamento |
| --- | --- |
| `agent/status` | `idle` ⇄ `running`, espelhado a cada transição |
| `agent/inbox/inserted` / `claimed` / `discarded` | a entrada pendente é **reivindicada** quando entra em um passo (nunca registrada como cancelamento) |
| `agent/pre-step` | despachado antes de cada passo; um `reject` bloqueia o turno (razão `turn/end` = `blocked`) e o Pi nunca é prompted |
| `agent/turn-stopping` | despachado na fronteira de parada do turno; a direção injetada ali roda mais um passo dentro do mesmo turno |
| `agent/session-start` | `source: 'startup'` para uma sessão nova, `'resume'` para uma sessão persistida |
| `agent/error` | reportado na fronteira viva; o turno ainda fecha com uma razão de erro |

Dois eventos de agente **não** são emitidos, porque sua semântica não pode ser honrada através da fronteira de processo: `agent/request` e `agent/request-error` envolvem a própria chamada ao modelo, que acontece dentro do filho do Pi. Um listener que precise influenciar a chamada ao modelo tem de usar as próprias extensões do Pi.

## Passagem de sessão em andamento

Uma sessão não precisa nascer sob o Pi para ser conduzida por ele. Se uma sessão já rodou turnos sob o loop nativo do DSH (ou sob um filho do Pi anterior), retomá-la por este plugin retoma a conversa de onde parou: o log de eventos do DSH (`user/message`, `assistant/message`, `tool/call`, `tool/result`) é convertido em um arquivo de sessão do Pi e o novo filho o carrega com `--session`, então o histórico completo — incluindo os turnos nativos do DSH anteriores — entra na janela de contexto dele.

- O DSH continua sendo a única fonte da verdade; o arquivo do Pi é um snapshot reconstruído, regenerado a cada create/resume (sem divergência, sem duplicação).
- Os blocos de mensagem do DSH mapeiam nativamente: `text` → `text`, `reasoning` → `thinking`, `tool-call` → `toolCall` (arguments reanalisados), `tool/result` → `toolResult` (nome da ferramenta recuperado do log de chamadas).
- Blocos de imagem são ignorados por enquanto (as referências de attachment precisam do serviço de anexos em execução); o histórico em texto carrega o contexto.
- O arquivo reconstruído mantém uma identidade de sessão estável (derivada do id de sessão do DSH), então a passagem é uma continuação, não uma sessão nova.
- Os arquivos de sessão ficam em `~/.dsh/pi-sessions/<session-id>.jsonl` para auditoria.

```
Modo padrão do DSH:   turno 1 ── turno 2 ── turno 3        (loop nativo)
                                        │
        retomar via este plugin ────────┘  reconstrói a sessão Pi a partir do log do DSH
                                        ▼
Modo pi:              [histórico carregado] ── turno 4 ── …  (loop Pi, contexto completo)
```

## Subagentes no Pi

Configuração separada do loop principal: o plugin do provider é sua própria linha de profile, e os dois motores são ligáveis independentemente — loop principal `pi` com subagentes nativos, loop principal nativo com subagentes `pi`, ou ambos no `pi`.

```yaml
# Delegação de subagente no motor Pi (independente da linha do loop principal):
- insert:
    - id: subagent-pi
      name: 'dsh-pi-agent/subagent'
      config:
        providerName: pi
        piPath: 'pi'                  # padrão: busca no PATH
        model: 'provider/model'      # omita para usar o padrão configurado do pi
        timeoutMs: 600000

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: pi                  # 'spawn'/'fork' para filhos nativos do DSH
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

Cada delegação spawna um `pi -p <tarefa>` novo no diretório de trabalho da sessão pai: prompt de sistema puro do Pi, suas próprias ferramentas, sua própria descoberta de `AGENTS.md`. Nada da conversa, persona ou superfície de ferramentas do pai atravessa a fronteira de processo — `inheritsParentContext: false`, zero colisão de prompt.

## Requisitos

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) no `PATH` (ou passe `piPath`)
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) (`npm i -g @deepseek-ai/dsh`) com um profile expondo os serviços `sessions` e `agents` (a montagem padrão do frontend)
- Deps de peer: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-session`

## Instalação

```bash
npm install dsh-pi-agent
```

O pacote está no registro do npm ([dsh-pi-agent](https://www.npmjs.com/package/dsh-pi-agent)). Monte-o a partir de qualquer profile do DSH (veja [dsh-pi](https://github.com/Micheleww/dsh-pi) para um profile web pronto).

Relacionado: o [ecossistema pi](https://github.com/earendil-works/pi) também tem [pi-gui](https://github.com/minghinmatthewlam/pi-gui), [pi-hosts](https://github.com/hunvreus/pi-hosts), [pi-zentui](https://www.npmjs.com/package/pi-zentui); o DSH faz ponte nativamente com [Claude Code](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-claude-code) e [Codex](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) como motores de subagente — o dsh-pi-agent adiciona o **pi** como opção de motor e de loop da mesma forma.

## Uso

Monte na camada de patch do profile (`cordis.patch.yml`):

```yaml
# Use o loop do Pi para todas as novas sessões.
- insert:
    - id: pi-agent
      name: 'dsh-pi-agent'
      config:
        piPath: 'pi'                      # ou um caminho absoluto
        cwd: '/path/to/your/project'      # diretório de trabalho das sessões Pi
        model: 'anthropic/claude-sonnet-4-5'  # rota provider/model
        debug: false

# Volte ao loop do próprio DSH: desabilite esta entrada e reative o agent-loop.
# - id: pi-agent
#   disabled: true
```

### Configuração

| Chave | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Executável do Pi; resolvido a partir do `PATH` |
| `cwd` | `string` | `process.cwd()` | Diretório de trabalho das sessões Pi |
| `model` | `string` | — | Rota de modelo do Pi (`provider/model`) |
| `debug` | `boolean` | `false` | Anexa diagnósticos do protocolo a `<tmpdir>/dsh-pi-agent.log` |

## Notas de plataforma

- **Windows**: o Pi é instalado como um shim de comando. O plugin resolve o shim (`.exe`/`.com`/`.cmd`/`.bat`) e lança um `.cmd`/`.bat` através do `cmd.exe` com todos os argumentos entre aspas, então o `pi.cmd` funciona sem configuração. Aponte `piPath` para o shim se ele não estiver no `PATH`.
- **POSIX**: o shim é um script executável e é gerado diretamente.
- O arquivo de diagnóstico fica no diretório temporário da plataforma (`os.tmpdir()`), então é gravável em qualquer plataforma.

## Depuração

Defina `debug: true`: cada comando RPC, evento, saída do processo filho e passo de ciclo de vida da fábrica é anexado a `<tmpdir>/dsh-pi-agent.log` (`%TEMP%` no Windows, `/tmp` nos demais). O stderr do próprio Pi é encaminhado para o mesmo log. Com `debug` desligado nenhum sink é instalado — a camada de protocolo não formata nenhum diagnóstico e não toca o disco.

## Desenvolvimento

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # compila e roda a suíte node:test
```

A suíte cobre a reconstrução do histórico (mapeamento de blocos, razões de parada, identidade da sessão), a tradução de eventos do Pi (resultados de ferramenta, ids de tool-call em streaming, encerramento, cancelamento, reivindicação da inbox) e o cliente RPC contra um binário `pi` falso que fala o protocolo JSONL real.

## Licença

Tri-licenciada, à sua escolha: **MIT**, **Apache-2.0** ou uma
**Licença Comercial** (`MIT OR Apache-2.0 OR LicenseRef-Proprietary`).

As opções MIT e Apache-2.0 são completas e gratuitas nos seus próprios
termos — a opção comercial nunca as restringe. A opção comercial cobre
redistribuição closed-source sem obrigação de atribuição, garantia ou
indenização do detentor dos direitos autorais, e isenção da concessão de
patentes do Apache-2.0; seus termos vinculantes vêm de um acordo escrito
separado.

Textos completos: [`LICENSE`](LICENSE), [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE),
[`LICENSE-COMMERCIAL`](LICENSE-COMMERCIAL).
