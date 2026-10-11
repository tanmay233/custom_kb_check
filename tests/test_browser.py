"""Opt-in real browser workflow; uses an isolated database and ephemeral HTTP port."""
import os
import socket
import threading
import time

import pytest
import uvicorn

from app.main import create_app


@pytest.mark.skipif(os.getenv("RUN_BROWSER_TESTS") != "1", reason="Set RUN_BROWSER_TESTS=1 to run browser tests")
def test_creation_save_reload_search_and_editing(tmp_path):
    from playwright.sync_api import expect, sync_playwright

    server = uvicorn.Server(uvicorn.Config(create_app(tmp_path / "browser-db"), log_level="error"))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(.05)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel=os.getenv("KG_TEST_BROWSER") or None)
            page = browser.new_page(viewport={"width": 1440, "height": 1050}, base_url=f"http://127.0.0.1:{port}")
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("dialog", lambda dialog: dialog.accept())
            page.goto(f"http://127.0.0.1:{port}")
            page.locator("#first-graph").click()
            page.locator("#new-graph-name").fill("Research network")
            page.locator("#graph-form button[type=submit]").click()
            expect(page.locator("#graph-title")).to_have_text("Research network")

            for name in ("Person", "Company"):
                page.locator("#type-name").fill(name)
                page.locator("#node-type-form button[type=submit]").click()
            page.locator("#rel-name").fill("WORKS_AT")
            page.locator("#rel-from").select_option(label="Person")
            page.locator("#rel-to").select_option(label="Company")
            page.locator("#rel-type-form button[type=submit]").click()

            for name, kind, description in [("Alice", "Person", "Solar energy researcher"), ("Acme", "Company", "Clean energy technology"), ("Bob", "Person", "Writes books")]:
                page.locator("#node-type").select_option(label=kind)
                page.locator("#node-name").fill(name)
                page.locator("#node-description").fill(description)
                page.locator("#node-form button[type=submit]").click()

            graph_id = page.locator(".graph-link.active").get_attribute("data-graph")
            draft = page.evaluate("id => JSON.parse(localStorage.getItem('graph-studio:draft:' + id))", graph_id)
            nodes = {node["name"]: node["id"] for node in draft["nodes"]}
            page.locator("#mapping-from").fill("Alice")
            page.locator("#mapping-to").fill(nodes["Acme"])
            page.locator("#mapping-submit").click()
            expect(page.locator("#graph-summary")).to_have_text("3 nodes · 1 connections")
            expect(page.locator(".graph-node")).to_have_count(3)
            expect(page.locator(".graph-edge")).to_have_count(1)

            # Unsaved drafts restore on refresh, but aren't in the database yet.
            assert page.request.get(f"/api/graphs/{graph_id}").json()["nodes"] == []
            page.reload()
            expect(page.locator("#graph-summary")).to_have_text("3 nodes · 1 connections")
            page.locator("#save").click()
            expect(page.locator("#save-status")).to_have_text("✓ All changes saved")
            page.reload()
            expect(page.locator("#graph-summary")).to_have_text("3 nodes · 1 connections")
            assert len(page.request.get(f"/api/graphs/{graph_id}").json()["nodes"]) == 3

            # Inspect real canvas nodes and verify UUID-based editing.
            page.locator(f'.graph-node[data-id="{nodes["Alice"]}"]').click()
            expect(page.locator("#inspector-content h3")).to_have_text("Alice")
            page.locator("#edit-node-lookup").fill(nodes["Alice"])
            page.locator("#load-node").click()
            page.locator("#edit-node-name").fill("Alice Updated")
            page.locator("#edit-node-form button[type=submit]").click()
            expect(page.locator("#inspector-content h3")).to_have_text("Alice Updated")
            page.locator("#save").click()
            expect(page.locator("#save-status")).to_have_text("✓ All changes saved")

            page.locator("#search-tab").click()
            page.locator("#search-mode").select_option("keyword")
            page.locator("#search-query").fill(nodes["Alice"])
            page.locator("#search-submit").click()
            expect(page.locator(".result h3")).to_have_text("Alice Updated")
            expect(page.locator(".result-connections")).to_contain_text("WORKS_AT")
            page.locator('[data-action="result-node"]').click()
            expect(page.locator("#edit-node-name")).to_have_value("Alice Updated")

            saved = page.request.get(f"/api/graphs/{graph_id}").json()
            edge_id = saved["edges"][0]["id"]
            page.locator("#edit-edge").select_option(edge_id)
            page.locator("#load-edge").click()
            page.locator("#mapping-from").fill(nodes["Bob"])
            page.locator("#mapping-submit").click()
            expect(page.locator("#inspector-content")).to_contain_text("Bob → Acme")
            page.locator("#save").click()
            expect(page.locator("#save-status")).to_have_text("✓ All changes saved")

            page.locator("#layout").click()
            page.evaluate("window.scrollTo(0,0)")
            screenshot = tmp_path / "graph-studio-desktop.png"
            page.screenshot(path=str(screenshot), full_page=True)
            print(f"Desktop screenshot: {screenshot}")
            page.set_viewport_size({"width": 390, "height": 844})
            page.evaluate("window.scrollTo(0,0)")
            expect(page.locator("#save")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            page.screenshot(path=str(tmp_path / "graph-studio-mobile.png"), full_page=True)
            page.set_viewport_size({"width": 1440, "height": 1050})

            page.locator("#edit-edge").select_option(edge_id)
            page.locator("#delete-edge").click()
            expect(page.locator(".graph-edge")).to_have_count(0)
            page.locator("#edit-node-lookup").fill(nodes["Bob"])
            page.locator("#load-node").click()
            page.locator("#delete-node").click()
            expect(page.locator(".graph-node")).to_have_count(2)
            page.locator("#save").click()
            expect(page.locator("#save-status")).to_have_text("✓ All changes saved")
            page.reload()
            expect(page.locator("#graph-summary")).to_have_text("2 nodes · 0 connections")

            page.locator("#new-graph").click()
            page.locator("#new-graph-name").fill("Separate graph")
            page.locator("#graph-form button[type=submit]").click()
            expect(page.locator("#graph-title")).to_have_text("Separate graph")
            expect(page.locator(".graph-node")).to_have_count(0)
            page.locator(f'[data-graph="{graph_id}"]').click()
            expect(page.locator(".graph-node")).to_have_count(2)
            assert errors == [], errors
            browser.close()
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()
