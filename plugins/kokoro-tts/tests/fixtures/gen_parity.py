"""Generate the Python parity fixtures the TypeScript coordinator port is tested against.

Run from plugins/kokoro-tts:
    UV_PROJECT_ENVIRONMENT=$(mktemp -d) uv run --frozen --project server python tests/fixtures/gen_parity.py

Writes bb/coord/fixtures/{turn,strip,chunks}.json from the reference
implementations in server/kokoro_turn.py and server/kokoro_server.py.
"""

import json
import os
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent.parent
OUT = PLUGIN / "bb" / "coord" / "fixtures"

sys.dont_write_bytecode = True
os.environ["KOKORO_HEADLESS"] = "1"  # kokoro_server skips the sounddevice import
sys.path.insert(0, str(PLUGIN / "server"))

from kokoro_server import sentence_chunks, strip_markdown  # noqa: E402
from kokoro_turn import (  # noqa: E402
    MODE_CEILING, apply_cue_prefs, extract_directive, first_sentence, full_text, route_cue, route_turn,
)


def directive(attrs):
    return f"::kokoro-tts{{{attrs}}}"


def block(weight, say=None):
    return directive(f'weight="{weight}"' if say is None else f'weight="{weight}" say="{say}"')


BLOCK = '::kokoro-tts{weight="speech" say="All done."}'

# Reply texts from tests/test_turn.py.
TEST_TURN = [
    "Build is green. Details follow.",
    "```only code```",
    block("speech", "Hi."),
    block("sound:done"),
    block("shout"),
    "# Title\n```x```\nHello there. More.",
    "plain",
    "First point.\n\nSecond point.\n" + block("silent"),
    "Run `pytest` now.\n\n```bash\nrm -rf /tmp/x\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nThen `src/app.ts` builds.",
    "Run `bb plugin update` then open `https://x.test/a`.",
    "This is one sentence. " * 1000,
    block("speech", "Words."),
    "Done.\n\n" + directive('weight="speech" say="All tests pass."'),
    "x\n\n" + directive('weight="sound:done"'),
    "x\n\n" + directive('weight="silent"'),
    directive("weight='speech' say=\"Hi there.\" flag"),
    directive("weight=speech"),
    directive('weight="speech" say="He said &quot;hi&quot; &amp; left."'),
    directive('weight="speech" say="Use {name} here."'),
    "Done.\r\n\r\n" + directive('weight="speech" say="Windows line."') + "\r\n",
    "Real first sentence.\n\n```markdown\n" + directive('weight="speech" say="Example."') + "\n```\n",
    "Write " + directive('weight="speech" say="No."') + " at the end.",
    '<!-- TTS_RESPONSE weight="speech"\nOld form.\nTTS_RESPONSE -->\nBuild is green. More.',
    directive('weight="sound:done"') + "\n\n" + directive('weight="speech" say="Final."'),
    directive('weight="speech"'),
    directive('weight="speech" say="   "'),
    directive('say="Nothing."'),
    directive('weight="sound:done"') + "\n\nReal words here. More.\n\n" + directive('weight="silent"'),
    "Build is green. More detail.\n\n" + directive('weight="speech" say="He said "hi" now."'),
    directive('weight="speech", say="x"'),
]

# Reply texts from the /turn, /replay and strip tests in tests/test_server_routes.py.
TEST_ROUTES = [
    "x\n" + BLOCK,
    BLOCK,
    '::kokoro-tts{weight="speech" say="https://example.com"}',
    "No directive here.",
    "   ",
    "",
    "## Result\n\nThe **build** passed; see [the log](https://ci.example/run/1) "
    "and `dist/app.js`.\n\n```sh\nnpm test\n```\n\n- One fix\n- Two tests\n" + BLOCK,
    '::kokoro-tts{weight="sound:working"}',
    "Again.",
    "**Again** now.",
    "All done.",
    "a" * 5000,
    "Hi.",
    '::kokoro-tts{weight="speech" say="**Bold** done."}',
]

EXTRA = [
    # Line endings and directive placement.
    "Line one.\r\nLine two.\r\n\r\n" + block("speech", "CRLF reply.") + "\r\n",
    "Intro text.\n\n```\n" + block("speech", "Fenced.") + "\n```\n\n" + block("speech", "Real one."),
    block("sound:attention") + "\n\n" + block("speech", "Second wins."),
    "Fallback sentence. More.\n\n" + directive('weight="speech" say="unbalanced'),
    directive("weight='speech' say='Single quoted.'"),
    directive("weight=sound:done"),
    directive("weight=speech say=Bare"),
    block("sound:attention"),
    block("sound:working"),
    # Entities.
    directive('weight="speech" say="A &quot;q&quot; &amp; b &#39;c&#39; d&nbsp;e caf&eacute;."'),
    "Caf&eacute; &amp; bar &quot;ok&quot;. Next.",
    # Emoji and variation selectors.
    "✅ Tests pass ⚠️ one warning. Done 🎉.",
    block("speech", "✅ All green ⚠️ check logs."),
    # URLs, paths, inline code.
    "See https://example.com/a/b?c=1 for details. Then more.",
    "Edit ~/path/file.ts and /abs/path/x now. Next.",
    "Open `~/path/file.ts` and `/abs/path/x` then `src/lib/util.ts`. Next.",
    "Run `" + "x" * 70 + "` now. Next.",
    "Run `npm run build -- --watch` here. Next.",
    # Tables.
    "Summary below.\n\n| Name | Value |\n|:-----|------:|\n| a | 1 |\n| b | 2 |\n\nAfter table.",
    # Markdown structure.
    "# Heading One\n\n## Heading Two\n\nBody text here. More.\n\n### Third\n\nEnd.",
    "Items:\n\n- First item\n  - Nested item\n    - Deeper item\n- Second item\n\n1. One\n2. Two",
    "> Quoted line one.\n> Quoted line two.\n\nAfter quote.",
    "This is ~~struck~~ text and **bold** and *italic* and _under_. Next.",
    "A [labeled link](https://x.test/a) and [](https://x.test/b) and <https://x.test/c>. Next.",
    "An ![alt text](img.png) image and ![](img2.png) bare. Next.",
    "<div>\n<p>Raw block html.</p>\n</div>\n\nAfter html.",
    "Inline <b>bold</b> and <br> break and <span class=\"x\">span</span>. Next.",
    # Lengths and edge shapes.
    ("Sentence number seven is right here. " * 200)[:7000],
    "```python\nprint('only code')\n```",
    "",
    " \n\t \n ",
    ("word " * 60)[:300],
    # Repeated past the 220-char chunk size so the boundaries split chunks.
    "First clause; second clause: third clause. Fourth part; fifth: sixth. " * 5,
    "Use flags e.g. this one. It takes 3.5 s to start. Done. " * 6,
]

CORPUS = list(dict.fromkeys(TEST_TURN + TEST_ROUTES + EXTRA))
ROUTE_MODES = ["quiet", "ambient", "brief", "full"]
CUE_MODES = list(MODE_CEILING)
CFGS = [{"working_sound": True, "attention_sound": True}, {"working_sound": False, "attention_sound": False}]


def main():
    turn = {
        "route": [
            {"text": t, "mode": m, "cfg": c, "out": apply_cue_prefs(route_turn(t, m), c)}
            for t in CORPUS for m in ROUTE_MODES for c in CFGS
        ],
        "cue": [
            {"sound": s, "mode": m, "cfg": c, "out": route_cue(s, m, c)}
            for s in ("attention", "done") for m in CUE_MODES for c in CFGS
        ],
        "directive": [{"text": t, "out": list(extract_directive(t))} for t in CORPUS],
        "first": [{"text": t, "out": first_sentence(t)} for t in CORPUS],
        "full": [{"text": t, "out": full_text(t)} for t in CORPUS],
    }
    strip = [{"in": t, "out": strip_markdown(t)} for t in CORPUS]
    chunks = [{"in": t, "out": sentence_chunks(t)} for t in CORPUS]

    OUT.mkdir(parents=True, exist_ok=True)
    for name, obj in (("turn", turn), ("strip", strip), ("chunks", chunks)):
        with open(OUT / f"{name}.json", "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
            f.write("\n")

    print(f"corpus {len(CORPUS)}")
    for key, cases in turn.items():
        print(f"{key} {len(cases)}")
    print(f"strip {len(strip)}")
    print(f"chunks {len(chunks)}")


if __name__ == "__main__":
    main()
