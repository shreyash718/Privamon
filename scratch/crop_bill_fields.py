from PIL import Image

im = Image.open('scratch/bill.png').convert('RGB')
w, h = im.size

# Find non-black bounding box
left = w
top = h
right = 0
bottom = 0

for y in range(0, h, 2):
    for x in range(0, w, 2):
        r, g, b = im.getpixel((x, y))
        if r > 35 or g > 35 or b > 35:
            if x < left: left = x
            if x > right: right = x
            if y < top: top = y
            if y > bottom: bottom = y

print(f"Bill bbox: left={left}, top={top}, right={right}, bottom={bottom}, width={right-left}, height={bottom-top}")
bill_crop = im.crop((left, top, right, bottom))
bill_crop.save('scratch/bill_cropped.png')

bw, bh = bill_crop.size
name_crop = bill_crop.crop((int(bw * 0.05), int(bh * 0.28), int(bw * 0.95), int(bh * 0.35)))
name_crop.save('scratch/field_name.png')

mob_crop = bill_crop.crop((int(bw * 0.05), int(bh * 0.34), int(bw * 0.95), int(bh * 0.41)))
mob_crop.save('scratch/field_mob.png')

imei_crop = bill_crop.crop((int(bw * 0.05), int(bh * 0.47), int(bw * 0.95), int(bh * 0.54)))
imei_crop.save('scratch/field_imei.png')

print("Saved field crops successfully.")
