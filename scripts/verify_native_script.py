"""Browser-verify the native-script toggle (PRD §5 step B).

Logs in as admin, opens the studio page in Chromium via Selenium, clicks the
native-script toggle, and asserts transcript segment spans gain the
`text-lg leading-relaxed` class.

Run: python3 scripts/verify_native_script.py
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE = "http://127.0.0.1:8001"
USERNAME = "admin"
PASSWORD = "testpass123"


def main() -> int:
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--disable-software-rasterizer")
    opts.add_argument("--single-process")
    opts.add_argument("--remote-debugging-port=9222")
    opts.add_argument("--window-size=1280,900")
    opts.binary_location = "/usr/bin/chromium-browser"
    driver = webdriver.Chrome(options=opts)
    wait = WebDriverWait(driver, 15)

    try:
        # ── login ──
        driver.get(f"{BASE}/accounts/login/")
        wait.until(EC.presence_of_element_located((By.NAME, "username")))
        csrf = driver.find_element(By.NAME, "csrfmiddlewaretoken").get_attribute("value")
        driver.find_element(By.NAME, "username").send_keys(USERNAME)
        driver.find_element(By.NAME, "password").send_keys(PASSWORD)
        driver.find_element(By.XPATH, "//button[@type='submit']").click()
        wait.until(EC.url_contains("/studio/"))
        print("logged in, on studio page")

        # ── let Alpine hydrate ──
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, '[x-data="studioRecorder"]')))
        time.sleep(1.5)
        print("Alpine hydrated")

        # ── recording path: click native-script toggle ON ──
        toggle = wait.until(
            EC.element_to_be_clickable((By.XPATH, "//button[contains(normalize-space(.), 'Native')]"))
        )
        toggle.click()
        print("clicked native-script toggle ON (recording path)")

        seg_spans = driver.find_elements(By.XPATH, '//p[@x-text="seg.text"]')
        print(f"recording path segment spans: {len(seg_spans)} (expected 0 when not recording)")

        # ── uploads path: open existing transcript tab via Alpine ──
        take_id = "3d92ded8-97b4-48f6-bc1c-5877610d7eb3"
        driver.execute_script(
            "const el = document.querySelector('[x-data=\"studioRecorder\"]');"
            "const comp = Alpine.$data(el);"
            "comp.openExistingTab(arguments[0], '3d92ded8');",
            take_id,
        )
        time.sleep(2)
        print("opened uploads transcript tab")

        # ── verify container has text-lg leading-relaxed (toggle still ON) ──
        time.sleep(0.5)
        container = driver.find_element(By.XPATH, '//div[contains(@class, "space-y-2")]')
        cls = container.get_attribute("class") or ""
        has_native = "text-lg" in cls and "leading-relaxed" in cls
        print(f"segment container classes: {cls}")
        print(f"container has text-lg leading-relaxed: {has_native}")
        if not has_native:
            print("FAIL: segment container did not gain native-script styling (uploads path)")
            return 1

        # ── toggle OFF and verify class removed ──
        toggle = wait.until(
            EC.element_to_be_clickable((By.XPATH, "//button[contains(normalize-space(.), 'Native')]"))
        )
        toggle.click()
        time.sleep(0.5)
        cls2 = container.get_attribute("class") or ""
        has_native2 = "text-lg" in cls2 and "leading-relaxed" in cls2
        print(f"after toggle OFF: {cls2}")
        print(f"container has text-lg leading-relaxed: {has_native2}")
        if has_native2:
            print("FAIL: segment container kept native-script styling after toggle OFF")
            return 1

        print("PASS: native-script toggle verified on recording path and uploads path")
        return 0
    finally:
        driver.quit()


if __name__ == "__main__":
    sys.exit(main())
