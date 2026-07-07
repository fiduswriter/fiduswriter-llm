import time

from testing.live_server import ChannelsLiveServerTestCase
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.wait import WebDriverWait
from selenium.common.exceptions import StaleElementReferenceException
from testing.selenium_helper import SeleniumHelper


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
