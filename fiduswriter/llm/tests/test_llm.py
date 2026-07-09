import json
import multiprocessing
import socket
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from django.conf import settings
from django.test import TestCase
from django.urls import reverse
from testing.live_server import ChannelsLiveServerTestCase
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.wait import WebDriverWait
from selenium.common.exceptions import StaleElementReferenceException
from testing.selenium_helper import SeleniumHelper


class LLMViewsTest(TestCase):
    def setUp(self):
        from user.models import User

        self.user = User.objects.create_user(
            username="Yeti", email="yeti@snowman.com", password="otter1"
        )

    def test_improve_without_api_key_returns_400(self):
        self.client.force_login(self.user)
        response = self.client.post(
            reverse("llm_improve"),
            data='{"text": "hello", "prompt": "fix"}',
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_models_without_api_key_returns_400(self):
        self.client.force_login(self.user)
        response = self.client.post(
            reverse("llm_models"),
            data='{"url": "https://example.com/v1/chat/completions"}',
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_preferences_save_and_return(self):
        self.client.force_login(self.user)
        response = self.client.post(
            reverse("llm_preferences"),
            data='{"url": "https://example.com/v1/chat/completions", "model": "m", "api_key": "k"}',
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(
            data["url"], "https://example.com/v1/chat/completions"
        )
        self.assertEqual(data["model"], "m")
        self.assertEqual(data["api_key"], "k")

    @patch("llm.views.AsyncClient")
    def test_improve_with_api_key_forwards_request(self, mock_client_cls):
        mock_response = (
            mock_client_cls.return_value.__aenter__.return_value.post.return_value
        )
        mock_response.status_code = 200
        mock_response.json = lambda: {
            "choices": [{"message": {"content": "improved text"}}]
        }

        self.user.preferences = {
            "llm_api_key": "user-key",
            "llm_model": "model-x",
        }
        self.user.save()
        self.client.force_login(self.user)

        response = self.client.post(
            reverse("llm_improve"),
            data='{"text": "hello", "prompt": "fix"}',
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "improved text")

        mock_client_cls.return_value.__aenter__.return_value.post.assert_called_once()
        _url, kwargs = (
            mock_client_cls.return_value.__aenter__.return_value.post.call_args
        )
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer user-key")
        self.assertEqual(kwargs["json"]["model"], "model-x")


class LLMTest(ChannelsLiveServerTestCase, SeleniumHelper):
    fixtures = ["initial_documenttemplates.json", "initial_styles.json"]

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.base_url = cls.live_server_url
        driver_data = cls.get_drivers(1)
        cls.driver = driver_data["drivers"][0]
        cls.client = driver_data["clients"][0]
        cls.driver.implicitly_wait(driver_data["wait_time"])
        cls.wait_time = driver_data["wait_time"]

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()
        super().tearDownClass()

    def setUp(self):
        self.user = self.create_user(
            username="Yeti", email="yeti@snowman.com", passtext="otter1"
        )
        self.user.preferences = {
            "llm_url": "https://openrouter.ai/api/v1/chat/completions",
            "llm_api_key": "test-api-key",
        }
        self.user.save()

    def tearDown(self):
        self.leave_site(self.driver)

    def assertInfoAlert(self, message):
        i = 0
        message_found = False
        while i < 100:
            i = i + 1
            info_alerts = self.driver.find_elements(
                By.CSS_SELECTOR, "body #alerts-outer-wrapper .alerts-info"
            )
            for alert in info_alerts:
                try:
                    if alert.text == message:
                        message_found = True
                        break
                except StaleElementReferenceException:
                    pass
            if not message_found:
                time.sleep(0.1)
                continue
        self.assertTrue(message_found)

    def test_menu_items_hidden_without_config(self):
        from user.models import User

        other_user = User.objects.create_user(
            username="NoLLM", email="nollm@snowman.com", password="otter1"
        )
        self.login_user(other_user, self.driver, self.client)
        self.driver.get(self.base_url + "/")
        WebDriverWait(self.driver, self.wait_time).until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, ".new_document button")
            )
        ).click()
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "editor-toolbar"))
        )

        # Open the tools menu.
        self.driver.find_element(
            By.XPATH, '//*[@id="header-navigation"]/div[4]/span'
        ).click()
        menu_items = [
            el
            for el in self.driver.find_elements(
                By.XPATH, '//*[normalize-space()="LLM text improvement"]'
            )
            if el.is_displayed()
        ]
        self.assertEqual(len(menu_items), 0)

    def test_menu_items_present(self):
        self.login_user(self.user, self.driver, self.client)
        self.driver.get(self.base_url + "/")
        WebDriverWait(self.driver, self.wait_time).until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, ".new_document button")
            )
        ).click()
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "editor-toolbar"))
        )

        # Type some text so the LLM has something to improve.
        body_input = self.driver.find_element(By.CSS_SELECTOR, ".doc-body")
        body_input.click()
        body_input.send_keys("Thes text has some erors.")

        # Open the tools menu and look for the LLM entry.
        self.driver.find_element(
            By.XPATH, '//*[@id="header-navigation"]/div[4]/span'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="LLM text improvement"]'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="Improve entire text"]'
        ).click()

        # The LLM dialog should be open.
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "llm-prompt"))
        )


LLM_IMPROVED_SUFFIX = " improved"
LLM_GLOBAL_COMMENT = "This is a global LLM comment."


class MockLLMHandler(BaseHTTPRequestHandler):
    """A tiny mock LLM server.

    It makes a small word-level change ("erors" -> "errors") and appends a
    suffix to each TEXT TO IMPROVE block so the frontend has predictable
    changes to verify.
    """

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_response(404)
            self.end_headers()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        messages = data.get("messages", [])
        user_message = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                user_message = message.get("content", "")
                break

        # Delay the response a little so the Selenium test can observe the
        # editor being locked while waiting for the LLM.
        time.sleep(1)

        if "DOCUMENT TO REVIEW:" in user_message:
            content = LLM_GLOBAL_COMMENT
        else:
            marker = "TEXT TO IMPROVE:"
            if marker in user_message:
                text = user_message.split(marker, 1)[1].strip()
            else:
                text = ""
            if text:
                # Make a word-level change so tests can verify both deletions
                # and insertions.
                text = text.replace("erors", "errors")
                content = text + LLM_IMPROVED_SUFFIX
            else:
                content = LLM_IMPROVED_SUFFIX

        response = json.dumps(
            {"choices": [{"message": {"content": content}}]}
        )

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        try:
            self.wfile.write(response.encode("utf-8"))
        except BrokenPipeError:
            # The client may have closed the connection (e.g. test timeout or
            # assertion failure); nothing left to do.
            pass


def get_free_port():
    sock = socket.socket(socket.AF_INET, type=socket.SOCK_STREAM)
    sock.bind(("localhost", 0))
    _address, port = sock.getsockname()
    sock.close()
    return port


class LLMSeleniumTest(ChannelsLiveServerTestCase, SeleniumHelper):
    fixtures = ["initial_documenttemplates.json", "initial_styles.json"]

    @classmethod
    def start_server(cls, port):
        httpd = HTTPServer(("", port), MockLLMHandler)
        httpd.serve_forever()

    @classmethod
    def setUpClass(cls):
        cls.server_port = get_free_port()
        cls.server = multiprocessing.Process(
            target=cls.start_server,
            args=(cls.server_port,),
        )
        cls.server.daemon = True
        cls.server.start()
        settings.LLM_URL = (
            f"http://localhost:{cls.server_port}/v1/chat/completions"
        )
        settings.LLM_API_KEY = "test-server-key"
        super().setUpClass()
        cls.base_url = cls.live_server_url
        driver_data = cls.get_drivers(1)
        cls.driver = driver_data["drivers"][0]
        cls.client = driver_data["clients"][0]
        cls.driver.implicitly_wait(driver_data["wait_time"])
        cls.wait_time = driver_data["wait_time"]

    @classmethod
    def tearDownClass(cls):
        cls.driver.quit()
        cls.server.terminate()
        super().tearDownClass()

    def setUp(self):
        self.user = self.create_user(
            username="Yeti", email="yeti@snowman.com", passtext="otter1"
        )
        self.user.preferences = {
            "llm_url": (
                f"http://localhost:{self.server_port}/v1/chat/completions"
            ),
            "llm_api_key": "test-user-key",
        }
        self.user.save()

    def tearDown(self):
        self.leave_site(self.driver)

    def open_llm_dialog(self):
        self.login_user(self.user, self.driver, self.client)
        self.driver.get(self.base_url + "/")
        self.click_new_document_button(self.driver)
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".doc-body"))
        )
        body = self.driver.find_element(By.CSS_SELECTOR, ".doc-body")
        body.click()
        body.send_keys("Thes text has some erors.")

        # Open the Tools menu and start the LLM improvement flow.
        self.driver.find_element(
            By.XPATH, '//*[@id="header-navigation"]/div[4]/span'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="LLM text improvement"]'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="Improve entire text"]'
        ).click()

        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "llm-prompt"))
        )

    def open_llm_dialog_with_rich_text(self):
        """Create a document with bold/italic text and a footnote, then open the LLM dialog."""
        self.login_user(self.user, self.driver, self.client)
        self.driver.get(self.base_url + "/")
        self.click_new_document_button(self.driver)
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".doc-body"))
        )
        body = self.driver.find_element(By.CSS_SELECTOR, ".doc-body")
        body.click()
        # Type text with inline formatting. The word "erors" will be fixed to
        # "errors" by the mock LLM.
        body.send_keys("Thes ")
        body.send_keys(Keys.CONTROL, "b")
        body.send_keys("text")
        body.send_keys(Keys.CONTROL, "b")
        body.send_keys(" has ")
        body.send_keys(Keys.CONTROL, "i")
        body.send_keys("erors")
        body.send_keys(Keys.CONTROL, "i")
        body.send_keys(". ")

        # Add a footnote at the end of the paragraph.
        body.click()
        body.send_keys(Keys.END)
        self.driver.find_element(By.XPATH, '//*[@title="Footnote"]').click()
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CLASS_NAME, "footnote-container"))
        )
        footnote_editor = self.driver.find_element(
            By.CSS_SELECTOR, "#footnote-box-container .ProseMirror"
        )
        footnote_editor.click()
        footnote_editor.send_keys("footnote erors")
        body.click()

        # Open the Tools menu and start the LLM improvement flow.
        self.driver.find_element(
            By.XPATH, '//*[@id="header-navigation"]/div[4]/span'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="LLM text improvement"]'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="Improve entire text"]'
        ).click()

        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "llm-prompt"))
        )

    def run_llm(self, output_mode, _expected_alert):
        if output_mode != "proposals":
            self.driver.find_element(
                By.CSS_SELECTOR,
                f'input[name="llm-output-mode"][value="{output_mode}"]',
            ).click()

        prompt = self.driver.find_element(By.ID, "llm-prompt")
        prompt.clear()
        prompt.send_keys("Fix the grammar")

        self.driver.find_element(
            By.XPATH,
            (
                '//div[contains(@class,"fw-dialog-buttonpane")]//button'
                '[normalize-space()="Improve"]'
            ),
        ).click()

        # Wait for the progress task to appear, then verify the editor is
        # locked by checking the contenteditable attribute on the ProseMirror
        # root that contains the document body.
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, ".fw-progress-task")
            )
        )
        editable_state = self.driver.execute_script(
            """
            let el = document.querySelector('.doc-body');
            while (el && !el.classList.contains('ProseMirror')) {
                el = el.parentElement;
            }
            return el ? el.getAttribute('contenteditable') : null;
            """
        )
        self.assertEqual(editable_state, "false")

        # Wait for the LLM work to finish (progress task disappears).
        WebDriverWait(self.driver, self.wait_time).until(
            EC.invisibility_of_element_located(
                (By.CSS_SELECTOR, ".fw-progress-task")
            )
        )

    def test_llm_direct_application(self):
        self.open_llm_dialog_with_rich_text()
        self.run_llm("direct", "LLM improvement applied.")
        WebDriverWait(self.driver, self.wait_time).until(
            EC.text_to_be_present_in_element(
                (By.CSS_SELECTOR, ".doc-body"), LLM_IMPROVED_SUFFIX.strip()
            )
        )

        # Verify that bold and italic marks were preserved by the LLM pipeline.
        strong_text = self.driver.find_element(
            By.CSS_SELECTOR, ".doc-body strong"
        ).text
        self.assertEqual(strong_text, "text")
        em_text = self.driver.find_element(
            By.CSS_SELECTOR, ".doc-body em"
        ).text
        self.assertEqual(em_text, "errors")

        # Verify that the footnote content was also improved.
        footnote_text = self.driver.find_element(
            By.CSS_SELECTOR, ".footnote-container p"
        ).text
        self.assertIn(LLM_IMPROVED_SUFFIX.strip(), footnote_text)

    def test_llm_tracked_changes(self):
        self.open_llm_dialog()
        self.run_llm("changes", "LLM improvement applied.")
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, ".doc-body .insertion")
            )
        )
        insertions = self.driver.find_elements(
            By.CSS_SELECTOR, ".doc-body .insertion"
        )
        insertion_text = " ".join(ins.text for ins in insertions)
        self.assertIn(LLM_IMPROVED_SUFFIX.strip(), insertion_text)
        deletions = self.driver.find_elements(
            By.CSS_SELECTOR, ".doc-body .deletion"
        )
        self.assertTrue(deletions)

    def test_llm_proposals(self):
        self.open_llm_dialog()
        self.run_llm("proposals", "LLM proposals created.")
        proposal = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, ".doc-body .llm-proposal")
            )
        )
        self.assertTrue(proposal.is_displayed())

    def test_llm_comments(self):
        self.open_llm_dialog()
        self.run_llm("comments", "LLM comments added.")
        comment = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, "#margin-box-container .margin-box.comment")
            )
        )
        self.assertIn(LLM_IMPROVED_SUFFIX.strip(), comment.text)

    def test_llm_global_comment(self):
        self.open_llm_dialog()
        self.run_llm("global_comment", "LLM document comment added.")
        comment = WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located(
                (
                    By.CSS_SELECTOR,
                    (
                        "#global-comment-container .margin-box.comment"
                        ".global-comment"
                    ),
                )
            )
        )
        self.assertIn(LLM_GLOBAL_COMMENT, comment.text)

    def test_llm_preferences_page(self):
        # Create a user without any LLM configuration so the menu is hidden.
        user = self.create_user(
            username="NoLLM", email="nollm@snowman.com", passtext="otter1"
        )
        self.login_user(user, self.driver, self.client)

        # Open the user profile page.
        self.driver.get(self.base_url + "/")
        self.driver.find_element(By.ID, "preferences-btn").click()
        self.driver.find_element(By.CSS_SELECTOR, ".fw-avatar-card").click()

        # Wait for the LLM settings panel injected by the plugin to render.
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "llm-url"))
        )

        url = f"http://localhost:{self.server_port}/v1/chat/completions"
        self.driver.find_element(By.ID, "llm-url").clear()
        self.driver.find_element(By.ID, "llm-url").send_keys(url)
        self.driver.find_element(By.ID, "llm-api-key").clear()
        self.driver.find_element(By.ID, "llm-api-key").send_keys("test-user-key")
        self.driver.find_element(By.ID, "llm-model-manual").clear()
        self.driver.find_element(By.ID, "llm-model-manual").send_keys(
            "mock-model"
        )

        self.driver.find_element(By.ID, "submit-profile").click()

        # Wait for the save indicator to disappear.
        WebDriverWait(self.driver, self.wait_time).until(
            EC.invisibility_of_element_located(
                (By.CSS_SELECTOR, "#fw-wait.fw-active")
            )
        )

        # Verify the saved preferences make the LLM menu available.
        self.driver.get(self.base_url + "/")
        self.click_new_document_button(self.driver)
        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, ".doc-body"))
        )
        body = self.driver.find_element(By.CSS_SELECTOR, ".doc-body")
        body.click()
        body.send_keys("Thes text has some erors.")

        self.driver.find_element(
            By.XPATH, '//*[@id="header-navigation"]/div[4]/span'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="LLM text improvement"]'
        ).click()
        self.driver.find_element(
            By.XPATH, '//*[normalize-space()="Improve entire text"]'
        ).click()

        WebDriverWait(self.driver, self.wait_time).until(
            EC.presence_of_element_located((By.ID, "llm-prompt"))
        )
