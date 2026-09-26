"""Meaningful negative controls for the template appearance gate."""
import sys
import unittest
from pathlib import Path
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from template_image_diff import compare_images


class AppearanceControls(unittest.TestCase):
    def setUp(self):
        self.page = Image.new("RGB", (600, 800), "white")
        self.draw = ImageDraw.Draw(self.page)
        self.draw.rectangle((40, 50, 250, 72), fill="#222222")
        for y in range(110, 700, 20):
            self.draw.rectangle((40, y, 550, y + 4), fill="#333333")

    def check(self, actual):
        return compare_images(self.page, actual)[0]["passed"]

    def test_identical_image_and_tiny_channel_noise_pass(self):
        self.assertTrue(self.check(self.page.copy()))
        self.assertTrue(self.check(self.page.point(lambda v: min(255, v + 1))))

    def test_blank_or_resized_output_fails(self):
        self.assertFalse(self.check(Image.new("RGB", self.page.size, "white")))
        self.assertFalse(self.check(self.page.resize((601, 800))))
        self.assertFalse(compare_images(Image.new("RGB", (20, 20), "white"),
                                        Image.new("RGB", (20, 20), "white"))[0]["passed"])

    def test_one_pixel_layout_shift_fails(self):
        shifted = Image.new("RGB", self.page.size, "white")
        shifted.paste(self.page, (1, 0))
        self.assertFalse(self.check(shifted))

    def test_missing_single_line_fails(self):
        missing = self.page.copy()
        ImageDraw.Draw(missing).rectangle((40, 310, 550, 314), fill="white")
        self.assertFalse(self.check(missing))

    def test_color_change_below_per_pixel_cutoff_still_fails(self):
        # A widespread 10-level color shift must not disappear below the
        # 12-level per-pixel threshold; the content-normalized mean catches it.
        self.assertFalse(self.check(self.page.point(lambda v: min(255, v + 10))))

    def test_clipped_heading_fails(self):
        clipped = self.page.copy()
        ImageDraw.Draw(clipped).rectangle((40, 50, 250, 55), fill="white")
        self.assertFalse(self.check(clipped))

    def test_transparency_and_oversized_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            compare_images(self.page, self.page.convert("RGBA"))
        with self.assertRaises(ValueError):
            compare_images(Image.new("RGB", (1500, 1500)), Image.new("RGB", (1500, 1500)))


if __name__ == "__main__":
    unittest.main()
