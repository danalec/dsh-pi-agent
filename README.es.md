# dsh-pi-loop

[English](README.md) | [中文](README.zh.md) | [Português (BR)](README.pt-BR.md) | [日本語](README.ja.md) | Español

> **Nota:** esta traducción sigue una revisión anterior del README; el texto canónico es [README.md](README.md).

Ejecuta el [Pi coding agent](https://github.com/earendil-works/pi) ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) como agent loop dentro de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ([`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)): un plugin `Agent` de DSH que conduce un proceso hijo `pi --mode rpc` sin interfaz, de modo que el frontend de DSH — registro de sesión, hooks, presets, web UI — funciona sin cambios.

> **¿Buscas algo de esto?**
> - *"¿Cómo uso pi dentro de DeepSeek Harness / DSH?"* — estás en el sitio correcto.
> - *"¿Cambiar el agent-loop de DSH por el loop de pi coding agent?"* — este plugin sustituye la fábrica por un proceso hijo `pi --mode rpc`.
> - *"¿Ejecutar pi con una web UI / frontend de navegador?"* — dsh-pi-loop + la app web oficial de DSH le da a pi la interfaz web completa: persistencia de sesión, hooks, presets, selección de modelo.
> - *"¿Usar un prompt mínimo y limpio dentro de DSH?"* — el motor pi conserva su prompt de sistema de ~300 tokens y sus cuatro herramientas; el ensamblaje de prompts de DSH nunca llega al modelo. Cero inyección de prompts.
> - *"¿Subagentes Claude Code / Codex dentro de DSH?"* — DSH ya los soporta de forma nativa; este plugin añade pi como opción de motor del mismo modo.

```
Frontend de DSH (sesiones, hooks, presets, persistencia SQLite, web UI)
        │
dsh-pi-loop  (este plugin: AgentFactory + traducción de eventos + traspaso de historial)
        │  spawn + JSONL sobre stdio
        │  comandos: set_model / prompt / steer / abort
        ▼
pi --mode rpc --session <historial reconstruido>   (el agent loop de Pi, intacto)
```

En cada create/resume el plugin reconstruye un archivo de sesión de Pi a partir del registro de eventos durable de DSH y lanza el proceso hijo con `--session`, de modo que la ventana de contexto del hijo ya contiene la conversación completa — incluidos los turnos que se ejecutaron bajo el loop nativo de DSH antes del cambio (véase [Traspaso de sesión en curso](#traspaso-de-sesión-en-curso)).

## Por qué

Pi es un harness mínimo: un prompt de sistema de ~300 tokens, cuatro herramientas (`read`/`bash`/`edit`/`write`) y cero inyecciones a mitad de sesión. DSH ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)) es una plataforma basada en plugins: sesiones durables, políticas, cadenas de aprobación y un registro completo de ensamblaje de prompts.

Este plugin te da ambos a la vez: **la cáscara de ingeniería de DSH alrededor del motor limpio de Pi.** Cuando el plugin está activo, el modelo ve exactamente lo que vería ejecutando `pi` directamente en el mismo directorio de trabajo — sin secciones de prompt adicionales, sin herramientas adicionales, sin recordatorios ocultos. El propio ensamblaje de prompts de DSH (`dsh-system-prompt`) y su superficie de herramientas quedan totalmente al margen en las sesiones dirigidas por esta fábrica.

También permite un experimento A/B limpio: mismo frontend, mismo formato de sesión, se activa o desactiva el plugin para comparar el loop nativo de DSH con el loop puro de Pi.

## Qué cambia y qué no

| Capa | Comportamiento |
| --- | --- |
| Prompt de sistema / herramientas / contexto | **Intacto** — idéntico a ejecutar `pi` en el mismo directorio (los archivos de contexto como `AGENTS.md` los carga el propio Pi) |
| Enrutamiento de modelo | `set_model` por sesión; el modelo solicitado por un subagente delegado tiene prioridad sobre el valor por defecto de la fábrica. Un modelo sin proveedor toma prestada el proveedor del valor por defecto — el campo de proveedor nunca recibe un id de modelo |
| Dirección (steering) | `send(..., 'next-turn' \| 'next-step')` de DSH se corresponde con el `steer` de Pi — inyecta instrucciones a mitad de ejecución. La instrucción se entrega al loop en marcha exactamente una vez |
| Persistencia de sesión | Los eventos de sesión de DSH siguen siendo la fuente durable de verdad; un archivo de sesión de Pi se reconstruye a partir de ellos en cada create/resume, así que el hijo arranca con todo el historial |
| Aprobación / permisos | Se aplica el modelo de confianza local de Pi — las llamadas a herramientas de Pi no pasan por la cadena de aprobación de DSH |
| Respaldo | Desactiva la entrada de este plugin y el `dsh-agent-loop` del propio DSH vuelve a estar activo de inmediato |

## Mapeo de fronteras

El puente traduce los internos de Pi al modelo de turno/paso de DSH:

| DSH | Pi |
| --- | --- |
| un turno | un comando `prompt` (una ejecución de Pi) |
| un paso | un mensaje del asistente (una llamada al modelo más las ejecuciones de herramienta que pidió) |
| frontera de paso | el evento `turn_end` de Pi (el turno del asistente terminó) |
| entrada de next-step | el comando `steer` de Pi (entregado justo antes de la siguiente llamada al LLM) |

Un turno se cierra cuando Pi informa `agent_settled` — no con `agent_end`, que solo termina una ejecución de bajo nivel mientras que los reintentos, la recuperación por compactación y el trabajo en cola aún pueden seguir.

## Hooks de agente de DSH

El plugin implementa los eventos de agente de los que dependen el frontend y la cadena de políticas:

| Evento | Comportamiento |
| --- | --- |
| `agent/status` | `idle` ⇄ `running`, replicado en cada transición |
| `agent/inbox/inserted` / `claimed` / `discarded` | la entrada pendiente se **reclama** al entrar en un paso (nunca se registra como cancelación) |
| `agent/pre-step` | se despacha antes de cada paso; un `reject` bloquea el turno (razón `turn/end` = `blocked`) y nunca se le pide nada a Pi |
| `agent/turn-stopping` | se despacha en la frontera de parada del turno; la dirección inyectada ahí ejecuta otro paso dentro del mismo turno |
| `agent/session-start` | `source: 'startup'` para una sesión nueva, `'resume'` para una persistida |
| `agent/error` | se informa en la frontera viva; el turno se cierra igualmente con una razón de error |

Dos eventos de agente **no** se emiten, porque su semántica no puede respetarse a través de la frontera de proceso: `agent/request` y `agent/request-error` envuelven la propia llamada al modelo, que ocurre dentro del hijo de Pi. Un listener que necesite influir en la llamada al modelo tiene que usar las extensiones propias de Pi.

## Traspaso de sesión en curso

Una sesión no tiene que haber nacido bajo Pi para ser conducida por él. Si una sesión ya ejecutó turnos bajo el loop nativo de DSH (o bajo un hijo de Pi anterior), reanudarla mediante este plugin retoma la conversación donde se dejó: el registro de eventos de DSH (`user/message`, `assistant/message`, `tool/call`, `tool/result`) se convierte en un archivo de sesión de Pi y el nuevo hijo lo carga con `--session`, de modo que el historial completo — incluidos los turnos nativos de DSH anteriores — entra en su ventana de contexto.

- DSH sigue siendo la única fuente de verdad; el archivo de Pi es una instantánea reconstruida, regenerada en cada create/resume (sin divergencia, sin duplicados).
- Los bloques de mensaje de DSH se mapean de forma nativa: `text` → `text`, `reasoning` → `thinking`, `tool-call` → `toolCall` (arguments reanalizados), `tool/result` → `toolResult` (nombre de la herramienta recuperado del registro de llamadas).
- Los bloques de imagen se omiten por ahora (las referencias de attachment necesitan el servicio de adjuntos en ejecución); el historial en texto aporta el contexto.
- El archivo reconstruido conserva una identidad de sesión estable (derivada del id de sesión de DSH), así que el traspaso es una continuación, no una sesión nueva.
- Los archivos de sesión quedan en `~/.dsh/pi-sessions/<session-id>.jsonl` para auditoría.

```
Modo estándar de DSH:  turno 1 ── turno 2 ── turno 3        (loop nativo)
                                        │
        reanudar con este plugin ────────┘  reconstruye la sesión Pi desde el log de DSH
                                        ▼
Modo pi:               [historial cargado] ── turno 4 ── …  (loop Pi, contexto completo)
```

## Subagentes sobre Pi

Configuración separada del loop principal: el plugin del proveedor es su propia fila de profile, y los dos motores se pueden cambiar de forma independiente — loop principal `pi` con subagentes nativos, loop principal nativo con subagentes `pi`, o ambos sobre `pi`.

```yaml
# Delegación a subagente sobre el motor Pi (independiente de la fila del loop principal):
- insert:
    - id: subagent-pi
      name: 'dsh-pi-loop/subagent'
      config:
        providerName: pi
        piPath: 'pi'                  # por defecto se busca en el PATH
        model: 'provider/model'      # omítelo para usar el modelo por defecto de pi
        timeoutMs: 600000

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: pi                  # 'spawn'/'fork' para hijos nativos de DSH
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

Cada delegación lanza un `pi -p <tarea>` nuevo en el directorio de trabajo de la sesión padre: prompt de sistema puro de Pi, sus propias herramientas, su propio descubrimiento de `AGENTS.md`. Nada de la conversación, la persona ni la superficie de herramientas del padre cruza la frontera de proceso — `inheritsParentContext: false`, cero colisión de prompts.

## Requisitos

- Node.js ≥ 20
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) en el `PATH` (o pasa `piPath`)
- [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) (`npm i -g @deepseek-ai/dsh`) con un profile que exponga los servicios `sessions` y `agents` (el montaje estándar del frontend)
- Deps de peer: `@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-session`

## Instalación

```bash
# Link the working tree: the profile always runs your checkout (rebuild, then
# restart DSH). This is the development setup.
dsh plugin --profile desktop add link:/path/to/dsh-pi-loop

# Or install a copy of the directory (what `npm pack` would produce).
dsh plugin --profile desktop add file:/path/to/dsh-pi-loop
```

El paquete no está en el registro de npm — la publicación anterior de
`dsh-pi-loop` fue despublicada — así que instálalo directamente desde
GitHub. Móntalo desde cualquier profile de DSH (véase [dsh-pi](https://github.com/Micheleww/dsh-pi)
para un profile web listo).

Cada release también incluye el tarball empaquetado:
[github.com/danalec/dsh-pi-loop/releases](https://github.com/danalec/dsh-pi-loop/releases).

Relacionado: el [ecosistema pi](https://github.com/earendil-works/pi) también tiene [pi-gui](https://github.com/minghinmatthewlam/pi-gui), [pi-hosts](https://github.com/hunvreus/pi-hosts), [pi-zentui](https://www.npmjs.com/package/pi-zentui); DSH hace de puente nativo con [Claude Code](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-claude-code) y [Codex](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) como motores de subagente — dsh-pi-loop añade **pi** como opción de motor y de loop del mismo modo.

## Uso

Móntalo en la capa de parches del profile (`cordis.patch.yml`):

```yaml
# Usa el loop de Pi para todas las sesiones nuevas.
- insert:
    - id: pi-loop
      name: 'dsh-pi-loop'
      config:
        piPath: 'pi'                      # o una ruta absoluta
        cwd: '/path/to/your/project'      # directorio de trabajo de las sesiones Pi
        model: 'anthropic/claude-sonnet-4-5'  # ruta provider/model
        debug: false

# Vuelve al loop del propio DSH: desactiva esta entrada y vuelve a activar agent-loop.
# - id: pi-loop
#   disabled: true
```

### Configuración

| Clave | Tipo | Por defecto | Descripción |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Ejecutable de Pi; se resuelve desde el `PATH` |
| `cwd` | `string` | `process.cwd()` | Directorio de trabajo de las sesiones Pi |
| `model` | `string` | — | Ruta de modelo de Pi (`provider/model`) |
| `debug` | `boolean` | `false` | Añade diagnósticos del protocolo a `<tmpdir>/dsh-pi-loop.log` |

## Notas de plataforma

- **Windows**: Pi se distribuye como un shim de comando. El plugin resuelve el shim (`.exe`/`.com`/`.cmd`/`.bat`) y lanza un `.cmd`/`.bat` a través de `cmd.exe` con todos los argumentos entrecomillados, así que `pi.cmd` funciona sin más. Apunta `piPath` al shim si no está en el `PATH`.
- **POSIX**: el shim es un script ejecutable y se lanza directamente.
- El archivo de diagnóstico vive en el directorio temporal de la plataforma (`os.tmpdir()`), así que se puede escribir en cualquier plataforma.

## Depuración

Activa `debug: true`: cada comando RPC, evento, salida del proceso hijo y paso del ciclo de vida de la fábrica se añade a `<tmpdir>/dsh-pi-loop.log` (`%TEMP%` en Windows, `/tmp` en el resto). El stderr del propio Pi se reenvía al mismo log. Con `debug` apagado no se instala ningún sink: la capa de protocolo no formatea ningún diagnóstico y no toca el disco.

## Desarrollo

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # compila y ejecuta la suite de node:test
```

El runner de pruebas necesita Node ≥ 21 (soporte de glob); la biblioteca en sí
funciona en Node ≥ 20.11.

La suite cubre la reconstrucción del historial (mapeo de bloques, motivos de fin, identidad de sesión), la traducción de eventos de Pi (resultados de herramienta, ids de tool-call en streaming, cierre, cancelación, reclamación de la inbox) y el cliente RPC contra un binario `pi` falso que habla el protocolo JSONL real.

## Licencia

Con licencia triple, a tu elección: **MIT**, **Apache-2.0** o una
**Licencia Comercial** (`MIT OR Apache-2.0 OR LicenseRef-Proprietary`).

Las opciones MIT y Apache-2.0 son completas y gratuitas por sus propios
términos — la opción comercial nunca las restringe. La opción comercial
cubre la redistribución de código cerrado sin obligaciones de atribución,
una garantía o indemnización del titular de los derechos de autor, y la
exención de la concesión de patentes de Apache-2.0; sus términos vinculantes
provienen de un acuerdo escrito aparte.

Textos completos: [`LICENSE`](LICENSE), [`LICENSE-MIT`](LICENSE-MIT),
[`LICENSE-APACHE`](LICENSE-APACHE),
[`LICENSE-COMMERCIAL`](LICENSE-COMMERCIAL).
