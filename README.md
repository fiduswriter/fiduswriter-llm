FidusWriter-LLM
===============

FidusWriter-LLM is a Fidus Writer plugin that adds LLM-powered text improvements
to the editor.

Features
--------

- Improve the entire document text via the **Tools** menu.
- Improve a single selected paragraph via the selection menu.
- Changes are applied as tracked suggestions that the author can accept or reject.
- Configure your preferred LLM API URL and key in the user profile.

By default the plugin talks to `OpenRouter <https://openrouter.ai/>`_, which
offers access to many open-weight models. You can override the endpoint and
model in your ``configuration.py``.

Installation
------------

1. Install the plugin, for example::

    pip install fiduswriter-llm

2. Add ``llm`` to your ``INSTALLED_APPS`` setting in ``configuration.py``::

    INSTALLED_APPS += (
        ...
        'llm',
    )

3. Optional: configure a default LLM endpoint and model in ``configuration.py``::

    LLM_URL = "https://openrouter.ai/api/v1/chat/completions"
    LLM_MODEL = "meta-llama/llama-3.1-8b-instruct"
    LLM_EXTRA_HEADERS = {
        "HTTP-Referer": "https://example.com",
        "X-Title": "Fidus Writer",
    }

4. Run the transpiler to build the JavaScript bundle::

    python fiduswriter/manage.py transpile --force

5. (Re)start your Fidus Writer server.

Usage
-----

- Open a document in the editor.
- Choose **Tools → LLM text improvement → Improve entire text** to improve the
  whole document.
- Or select text inside a paragraph and click the **Improve with LLM** button
  in the selection menu to improve just that paragraph.
- Enter instructions in the dialog (for example ``Fix the grammar in this text``)
  and click **Improve**.
- The LLM's changes appear as tracked suggestions. Review and accept or reject
  them as usual.

Go to your user profile page to set your LLM API URL and API key. If you use
OpenRouter, you can generate an API key from your OpenRouter account.
