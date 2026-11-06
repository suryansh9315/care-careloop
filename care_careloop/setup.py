#!/usr/bin/env python

"""The setup script."""

from setuptools import find_packages, setup

with open("README.md") as readme_file:
    readme = readme_file.read()

requirements = [
    "celery",
    "django",
    "djangorestframework",
    "django-environ",
    "django-filter",
    # The clinical core models its data with pydantic, as CARE does throughout.
    "pydantic>=2",
]

setup(
    author="Open Healthcare Network",
    author_email="info@ohc.network",
    python_requires=">=3.13",
    classifiers=[
        "Development Status :: 2 - Pre-Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Natural Language :: English",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.13",
    ],
    description="CareLoop: care-gap outbound voice campaigns for CARE",
    install_requires=requirements,
    license="MIT license",
    long_description=readme,
    long_description_content_type="text/markdown",
    include_package_data=True,
    keywords="care_careloop",
    name="care_careloop",
    packages=find_packages(include=["care_careloop", "care_careloop.*"]),
    url="https://github.com/suryansh9315/care-careloop",
    version="0.1.0",
    zip_safe=False,
)
