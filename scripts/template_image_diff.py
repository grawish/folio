"""Fixed, content-normalized tolerances for the reviewed template PNGs.

This compares pixels at their original coordinates. It does not align, blur,
resize, crop or replace either input to make a changed layout pass.
"""
from PIL import Image, ImageChops, ImageStat

MAX_CHANNEL_CHANGE = 12
MAX_CHANGED_INK_FRACTION = 0.001
MAX_MEAN_INK_ERROR = 2.0
MAX_PIXELS = 2_000_000


def compare_images(expected, actual):
    if expected.size != actual.size:
        return {"passed": False, "reason": "Page image dimensions changed",
                "expectedSize": list(expected.size), "actualSize": list(actual.size)}, None
    if expected.width * expected.height > MAX_PIXELS:
        raise ValueError("Template image exceeds the comparison pixel budget")
    if expected.mode != "RGB" or actual.mode != "RGB":
        raise ValueError("Template comparison requires opaque RGB images")
    difference = ImageChops.difference(expected, actual)
    channels = difference.split()
    maximum = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    changed = maximum.point(lambda value: 255 if value > MAX_CHANNEL_CHANGE else 0)
    visible_difference = maximum.point(lambda value: 255 if value > 0 else 0)
    changed_pixels = changed.histogram()[255]
    # Normalize by visible content, not the large white area around a resume.
    channels = ImageChops.darker(expected, actual).split()
    minimum = ImageChops.darker(ImageChops.darker(channels[0], channels[1]), channels[2])
    ink = minimum.point(lambda value: 255 if value < 250 else 0)
    ink_pixels = ink.histogram()[255]
    if ink_pixels == 0:
        return {"passed": False, "reason": "Blank template images are not a baseline"}, changed
    changed_fraction = changed_pixels / ink_pixels
    mean_ink_error = sum(ImageStat.Stat(difference).sum) / (3 * ink_pixels)
    return {
        "passed": (changed_fraction <= MAX_CHANGED_INK_FRACTION and
                   mean_ink_error <= MAX_MEAN_INK_ERROR),
        "width": expected.width,
        "height": expected.height,
        "inkPixels": ink_pixels,
        "changedPixels": changed_pixels,
        "changedInkFraction": changed_fraction,
        "meanInkError": mean_ink_error,
        "tolerances": {
            "maximumIgnoredChannelChange": MAX_CHANNEL_CHANGE,
            "maximumChangedInkFraction": MAX_CHANGED_INK_FRACTION,
            "maximumMeanInkError": MAX_MEAN_INK_ERROR,
        },
    }, visible_difference


def diff_preview(expected, changed):
    faded = Image.blend(expected, Image.new("RGB", expected.size, "white"), 0.7)
    return Image.composite(Image.new("RGB", expected.size, "#dc2626"), faded, changed)
