Hie Everyone this will act as server side for our project..

We will use qwen vision language model (specifically **`qwen3-vl:2b`**) for server side testing..

According to your laptop capabilites pull the model which your laptop finds easy by downloading [ollam](https://ollama.com/) (command: `ollama pull qwen3-vl:2b`), feel free to ask on whatsapp if any problems.

Create a virtual env in python install packages of requiremets.txt and run the uvicorn server ask some llm if you get any problem.

Go to static routing site at your localhost (e.g., [http://localhost:9998/static/](http://localhost:9998/static/)) which will open simple html page just to check server side is doing its task.(Or whatever port it runs on default is 8000 mine was busy)

Use `test_redacted.png` as image here are dummy inputs to check server side.

**Task Prompt:**
```text
Click on the "Ask Google" search bar in the center of the screen and type "privacy preserving AI agents"
```

**Redacted Regions (JSON List):**
```json
[
  {
    "bbox": [1800, 10, 1900, 100],
    "reason": "User profile icon containing personal initials"
  }
]
```

**DOM:**
```html
<input type="text" aria-label="Search" class="gLFyf" name="q" title="Search">
```