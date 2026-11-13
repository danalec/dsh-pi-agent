# dsh-pi-loop

[English](README.md) | [中文](README.zh.md) | Português (BR) | [日本語](README.ja.md) | [Español](README.es.md)

Execute o [Pi coding agent](https://github.com/earendil-works/pi) ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) como agent loop dentro do [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ([`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): um plugin `Agent` do DSH que conduz um processo filho `pi --mode rpc` sem interface, de modo que o frontend do DSH — log de sessão, hooks, presets, web UI — funciona sem alterações.

> **Procurando alguma destas coisas?**
> - *"Como uso o pi dentro do DeepSeek Harness / DSH?"* — você está no lugar certo.
> - *"Trocar o agent-loop do DSH pelo loop do pi coding agent?"* — este plugin substitui a fábrica por um processo filho `pi --mode rpc`.
> - *"Rodar o pi com uma web UI / frontend de navegador?"* — dsh-pi-loop + o app web oficial do DSH dá ao pi a interface web completa: persistência de sessão, hooks, presets, seleção de modelo.
> - *"Usar um prompt mínimo e limpo dentro do DSH?"* — o motor pi mantém seu prompt de sistema de ~300 tokens e suas quatro ferramentas; a montagem de prompt do DSH nunca chega ao modelo. Zero injeção de prompt.
> - *"Subagentes Claude Code / Codex dentro do DSH?"* — o DSH já suporta isso nativamente; este plugin adiciona o pi como opção de motor da mesma forma.

```
Frontend do DSH (sessões, hooks, presets, persistência SQLite, web UI)
        │
dsh-pi-loop  (este plugin: AgentFactory + tradução de eventos + passagem de histórico)
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
| `agent/created` | o registro anuncia o agente com a origem da sessão (`startup` para uma nova, `resume` para uma persistida) |
| `agent/assistant-stream` | os frames de início/chunk/fim de uma tentativa do assistant |
| `agent/error` | reportado na fronteira viva; o turno ainda fecha com uma razão de erro |

Dois eventos de agente **não** são emitidos, porque sua semântica não pode ser honrada através da fronteira de processo: `agent/request` e `agent/request-error` envolvem a própria chamada ao modelo, que acontece dentro do filho do Pi. Um listener que precise influenciar a chamada ao modelo tem de usar as próprias extensões do Pi.

## Passagem de sessão em andamento

Uma sessão não precisa nascer sob o Pi para ser conduzida por ele. Se uma sessão já rodou turnos sob o loop nativo do DSH (ou sob um filho do Pi anterior), retomá-la por este plugin retoma a conversa de onde parou: o log de eventos do DSH (`user/message`, `assistant/message`, `tool/call`, `tool/result`) é convertido em um arquivo de sessão do Pi e o novo filho o carrega com `--session`, então o histórico completo — incluindo os turnos nativos do DSH anteriores — entra na janela de contexto dele.

- O DSH continua sendo a única fonte da verdade; o arquivo do Pi é um snapshot reconstruído, regenerado a cada create/resume (sem divergência, sem duplicação).
- Os blocos de mensagem do DSH mapeiam nativamente: `text` → `text`, `reasoning` → `thinking`, `tool-call` → `toolCall` (arguments reanalisados), `tool/result` → `toolResult` (nome da ferramenta recuperado do log de chamadas).
- O consumo de tokens viaja junto da mensagem do assistant: o leitor de sessão do Pi precisa dele para estimar o contexto, e uma retomada sem ele não consegue preparar a requisição.
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
      name: 'dsh-pi-loop/subagent'
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

## Compatibilidade

O plugin implementa a API de agente do DSH **0.2**, não a 0.1. É desenvolvido e testado contra o **DSH 0.2.2-rc.3**; a faixa de peer publicada aceita qualquer `0.2.2-rc.x` dessa linha.

| API do DSH | O que o plugin faz |
| --- | --- |
| `ctx.agents.setFactory` | registra a fábrica do Pi de forma síncrona, então uma sessão criada logo após a montagem já encontra a fábrica |
| `Agent.inbox` | o driver é dono da entrada pendente (`src/inbox.ts`); no DSH 0.2 `Inbox` virou interface estrutural e a implementação pertence ao driver |
| `Agent.model` | o driver é dono da escolha durável de modelo (`src/model.ts`) |
| `CreateAgentOptions.meta` | o `cwd` e a linhagem de fork da sessão (`parentSession`) viajam como metadados da sessão; o plugin repassa tudo direto para a fronteira da sessão |
| `ctx.agents.enter(agent)` | o agente entra no registro só com o agente — o elo com o pai é dado da sessão, não um segundo argumento |
| `agent/created` | o registro anuncia o agente com a origem da sessão (`startup` / `resume`) |
| `agent/assistant-stream` | os frames de início/chunk/fim de uma tentativa do assistant |
| `assistant/message` | carrega o stream do provedor dentro do evento (`stream`), em vez de eventos de chunk separados |
| `tool/result` | a mensagem de resultado da ferramenta carrega os blocos voltados ao modelo diretamente |
| persistência de sessão | `persistence.create()` / `persistence.open(id, 'write')` são donos do log armazenado; os eventos chegam ao backend pela assinatura dele em `session/event` |

### O que mudou no 0.2.2-rc.3

Os release candidates da linha 0.2.2 continuaram mexendo no contrato da fábrica, e o rc.3 é o formato contra o qual o plugin está escrito:

- `CreateAgentOptions.parentAgent` e `ResumeAgentOptions.parentAgent` saíram. A linhagem de fork agora é dado da sessão: `CreateAgentOptions.meta.parentSession` (um `SessionId`); `resume` não carrega metadado nenhum.
- `ctx.agents.enter(agent)` recebe apenas o agente — o argumento do pai não faz mais parte do contrato do registro.

O DSH confere a faixa de peer do plugin contra o runtime em execução no momento da instalação, então uma versão incompatível é reportada antes de o plugin ser montado.

## Requisitos

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) no `PATH` (ou passe `piPath`)
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) ≥ `0.2.2-rc.3` (`npm i -g @deepseek-ai/dsh`) com um profile expondo os serviços `sessions`, `agents` e `sessionProjections` (a montagem padrão do frontend)
- Deps de peer: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-persistence`, `@deepseek-ai/dsh-session-projection`, `@deepseek-ai/dsh-subagent`

## Instalação

```bash
# Link the working tree: the profile always runs your checkout (rebuild, then
# restart DSH). This is the development setup.
dsh plugin --profile desktop add link:/path/to/dsh-pi-loop

# Or install a copy of the directory (what `npm pack` would produce).
dsh plugin --profile desktop add file:/path/to/dsh-pi-loop
```

O pacote não está no registro do npm — a publicação anterior de
`dsh-pi-loop` foi despublicada — então instale direto do GitHub. Monte-o
a partir de qualquer profile do DSH (veja [dsh-pi](https://github.com/Micheleww/dsh-pi)
para um profile web pronto).

Cada release também traz o tarball empacotado:
[github.com/danalec/dsh-pi-loop/releases](https://github.com/danalec/dsh-pi-loop/releases).

Relacionado: o [ecossistema pi](https://github.com/earendil-works/pi) também tem [pi-gui](https://github.com/minghinmatthewlam/pi-gui), [pi-hosts](https://github.com/hunvreus/pi-hosts), [pi-zentui](https://www.npmjs.com/package/pi-zentui); o DSH faz ponte nativamente com [Claude Code](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-claude-code) e [Codex](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) como motores de subagente — o dsh-pi-loop adiciona o **pi** como opção de motor e de loop da mesma forma.

## Uso

Monte na camada de patch do profile (`cordis.patch.yml`):

```yaml
# Use o loop do Pi para todas as novas sessões.
- insert:
    - id: pi-loop
      name: 'dsh-pi-loop'
      config:
        piPath: 'pi'                      # ou um caminho absoluto
        cwd: '/path/to/your/project'      # diretório de trabalho das sessões Pi
        model: 'anthropic/claude-sonnet-4-5'  # rota provider/model
        debug: false

# Volte ao loop do próprio DSH: desabilite esta entrada e reative o agent-loop.
# - id: pi-loop
#   disabled: true
```

### Configuração

| Chave | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Executável do Pi; resolvido a partir do `PATH` |
| `cwd` | `string` | `process.cwd()` | Diretório de trabalho das sessões Pi (o `cwd` da própria sessão tem prioridade) |
| `model` | `string` | — | Rota de modelo do Pi (`provider/model`) |
| `pinModel` | `boolean` | `false` | Usar sempre `model`, ignorando a rota que o DSH pedir para a sessão. Os providers do DSH não são providers do Pi: sem isso, uma sessão criada com o seletor de modelo do frontend entregaria ao Pi uma rota que ele recusa |
| `debug` | `boolean` | `false` | Anexa diagnósticos do protocolo a `<tmpdir>/dsh-pi-loop.log` |

### Regras de montagem

Duas regras decidem se o plugin sobe:

1. **Um plugin novo é uma lista `insert:`.** Uma entrada `- id: pi-loop` solta
   só sobrescreve uma entrada que já existe — o loader responde
   `patch: entry "pi-loop" not found` e não monta nada.
2. **Só uma fábrica de agente pode ocupar a vaga.** O `dsh-agent-loop` do
   próprio DSH registra a fábrica primeiro, então `agent-loop` precisa estar
   desabilitado enquanto este plugin estiver montado. Deixar os dois
   habilitados falha com `an agent factory is already registered`.

## Ciclo de vida da sessão

| Fase | O que acontece |
| --- | --- |
| create | a sessão é preparada, o backend de persistência toma a posse de escrita do log armazenado, o arquivo de sessão do Pi é reconstruído a partir do log (ainda vazio) do DSH e o filho sobe com `--no-session` |
| turn | a entrada do DSH é reivindicada da inbox, o prompt vai para o Pi, os eventos do Pi viram eventos de sessão do DSH e o backend os armazena pela assinatura em `session/event` |
| resume | o log armazenado é lido de volta, um turno interrompido é fechado duravelmente, a sessão é semeada a partir do log e o filho sobe com `--session <arquivo reconstruído>` — com a conversa que ele já tinha |
| dispose | o filho é parado, o scope é desfeito e o handle de persistência é fechado |

A própria política de checkpoint do DSH faz o flush do log armazenado na fronteira da requisição, então um turno é durável quando a chamada ao modelo começa, não quando ela termina.

## Notas de plataforma

- **Windows**: o Pi é instalado como um shim de comando. O plugin resolve o shim (`.exe`/`.com`/`.cmd`/`.bat`) e lança um `.cmd`/`.bat` através do `cmd.exe` com todos os argumentos entre aspas, então o `pi.cmd` funciona sem configuração. Aponte `piPath` para o shim se ele não estiver no `PATH`.
- **POSIX**: o shim é um script executável e é gerado diretamente.
- O arquivo de diagnóstico fica no diretório temporário da plataforma (`os.tmpdir()`), então é gravável em qualquer plataforma.

## Diagnóstico

| Sintoma | Causa | Correção |
| --- | --- | --- |
| `patch: entry "pi-loop" not found` | a entrada é um override `- id:` solto, não um `insert:` | envolva-a em `- insert:` |
| `an agent factory is already registered` | o `agent-loop` do DSH ainda ocupa a vaga da fábrica | desabilite `agent-loop` na mesma camada de patch |
| `no agent factory registered (load an agent-loop plugin)` | o plugin não montou (nome de entrada errado, ou o profile não tem `agent-loop` nem `pi-loop`) | confira o `name:` da entrada e os diagnósticos do loader |
| O Pi recusa a rota de modelo | o DSH entregou ao Pi um provider do DSH | defina `model:` com uma rota do Pi e `pinModel: true` |
| O turno retomado não responde | o arquivo de sessão do Pi reconstruído está sem o consumo de tokens do assistant | reconstrua a partir do checkout atual (`npm run build`); o Pi precisa da contagem para preparar a requisição |
| Nada acontece no Windows | o `pi` é um shim `.cmd` que o app desktop não encontra | aponte `piPath` para o caminho absoluto do `pi.cmd` |
| Sem diagnósticos | `debug` está desligado | defina `debug: true` e leia `%TEMP%/dsh-pi-loop.log` |

## Depuração

Defina `debug: true`: cada comando RPC, evento, saída do processo filho e passo de ciclo de vida da fábrica é anexado a `<tmpdir>/dsh-pi-loop.log` (`%TEMP%` no Windows, `/tmp` nos demais). O stderr do próprio Pi é encaminhado para o mesmo log. Com `debug` desligado nenhum sink é instalado — a camada de protocolo não formata nenhum diagnóstico e não toca o disco.

## Desenvolvimento

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # compila e roda a suíte node:test
npm run build       # atualiza dist/ — é o que o profile carrega
```

O `package.json` fixa os pacotes `@deepseek-ai/dsh-*` em `0.2.2-rc.3` por um
bloco `overrides`: os pacotes do DSH pinam o peer dos outros numa versão exata,
então uma árvore misturada não resolve — todos precisam andar juntos.

`dist/` é o que o DSH carrega, então uma árvore linkada precisa de `npm run build`
(e de um restart do DSH) para pegar a mudança.

O runner de testes precisa de Node ≥ 21 (suporte a glob); a biblioteca roda em
Node ≥ 20.11.

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
