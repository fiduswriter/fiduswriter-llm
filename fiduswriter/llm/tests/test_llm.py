import time
from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse
from testing.live_server import ChannelsLiveServerTestCase
from selenium.webdriver.common.by import By
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
        self.assertEqual(data["url"], "https://example.com/v1/chat/completions")
        self.assertEqual(data["model"], "m")
        self.assertEqual(data["api_key"], "k")

    @patch("llm.views.AsyncClient")
    def test_improve_with_api_key_forwards_request(self, mock_client_cls):
        mock_response = mock_client_cls.return_value.__aenter__.return_value.post.return_value
        mock_response.status_code = 200
        mock_response.json = lambda: {"choices": [{"message": {"content": "improved text"}}]}

        self.user.preferences = {"llm_api_key": "user-key", "llm_model": "model-x"}
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
        _url, kwargs = mock_client_cls.return_value.__aenter__.return_value.post.call_args
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
            el for el in self.driver.find_elements(
                By.XPATH, '//*[normalize-space()="LLM text improvement"]'
            ) if el.is_displayed()
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
