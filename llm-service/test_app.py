import asyncio
import httpx
import pytest
from fastapi.testclient import TestClient
from app import app, Classification, mock_classify

client = TestClient(app)


@pytest.mark.parametrize(
    "text,category",
    [
        ("Fix API integration", "engineering"),
        ("Buy license seats", "sales"),
        ("Correct invoice tax", "finance"),
    ],
)
def test_categories(text, category):
    assert mock_classify(text).category == category


def test_ambiguous():
    assert mock_classify("Need help please").confidence < 0.8


def test_conflicting():
    assert mock_classify("API invoice issue").confidence < 0.8


def test_invalid_input():
    assert client.post("/classify", json={"description": ""}).status_code == 422


def test_structured_response(monkeypatch):
    monkeypatch.setenv("LLM_MODE", "mock")
    result = client.post("/classify", json={"description": "New license"}).json()
    assert Classification.model_validate(result["classification"]).confidence >= 0.8
    assert result["seconds"] >= 0


def test_invalid_model_output_falls_back(monkeypatch):
    async def invalid(_description):
        raise ValueError("invalid JSON")

    monkeypatch.setattr("app.classify", invalid)
    result = client.post("/classify", json={"description": "New license"}).json()
    assert result["fallback"] and result["classification"]["confidence"] == 0


def test_compatible_api_contract(monkeypatch):
    import app as module

    captured = {}

    async def handler(request):
        import json

        assert request.headers["Authorization"] == "Bearer ollama"
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"category":"finance","summary":"Tax correction","confidence":0.91}'
                        }
                    }
                ]
            },
        )

    real_client = httpx.AsyncClient
    monkeypatch.setenv("LLM_MODE", "ollama")
    monkeypatch.setenv("LLM_API_KEY", "")
    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler)),
    )
    assert asyncio.run(module.classify("Correct tax")).category == "finance"
    assert captured["response_format"]["type"] == "json_schema"
